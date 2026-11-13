/**
 * Per-run supervisor: one writer, one sampler, one action queue.
 *
 * The supervisor is the unit that `watch_arm` creates. It owns the run's watch
 * log (hash chain), the case manager, the probe, the deterministic guard and the
 * executor. It deliberately contains no model: M1 is guard-only, and the watch
 * officer runtime arrives in M2 behind the same interface.
 * @module dsh-overwatch/run
 */

import path from 'node:path'
import { CaseManager } from './cases.js'
import { Executor } from './executor.js'
import { evaluateGuard } from './guard.js'
import { Probe } from './probe.js'
import { evaluateSnapshot, contextPressureSignal, failureStreakSignal, stallSignal } from './signals.js'
import { WatchStore } from './store.js'
import { atomicWriteJson, clamp, ensureDir } from './util.js'

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/

/** @param {string} code @param {string} message @returns {Error & { code: string }} */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return /** @type {Error & { code: string }} */ (error)
}

export class RunSupervisor {
  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {typeof import('./config.js').DEFAULT_CONFIG} options.config
   * @param {any} options.ports
   * @param {string} options.dir run data directory
   * @param {() => number} [options.clock]
   * @param {{ info?: (message: string) => void, warn?: (message: string) => void }} [options.logger]
   */
  constructor(options) {
    if (!RUN_ID_PATTERN.test(options.runId)) throw fail('INVALID_RUN_ID', 'runId must match [A-Za-z0-9_-]{1,200}')
    this.runId = options.runId
    this.config = options.config
    this.ports = options.ports
    this.dir = options.dir
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    this.state = /** @type {'arming'|'watching'|'degraded'|'disarming'|'disarmed'|'failed'} */ ('arming')
    this.mode = options.config.mode
    this.armedAt = null
    this.disarmedAt = null
    this.failedReason = null
    this.timer = null
    this.ticking = false
    this.lastSampleAt = 0
    this.lastSampleRatio = -1
    this.lastSampleStatus = null
    this.lastErrorAt = 0
    this.noticeAt = new Map()
    /** @type {{ active: boolean, actionId: string, caseId: string, dueAt: number, minutes: number } | null} */
    this.throttle = null
    /** @type {{ interventions: number, lastActions: Map<string, number>, throttle: any }} */
    this.guardState = { interventions: 0, lastActions: new Map(), throttle: null }
    this.store = new WatchStore({
      dir: this.dir,
      runId: this.runId,
      clock: this.clock,
      maxBytes: options.config.storage.maxBytesPerRun,
      lockWaitMs: options.lockWaitMs ?? 2_000,
    })
    this.caseManager = new CaseManager({
      runId: this.runId,
      dir: this.dir,
      store: this.store,
      config: this.config,
      clock: this.clock,
      logger: this.logger,
    })
    this.probe = new Probe({ ports: this.ports, config: this.config, clock: this.clock, logger: this.logger })
    this.executor = new Executor({
      store: this.store,
      ports: [this.ports.swarm],
      policy: { mode: this.config.mode, autopilot: this.config.policy.autopilot },
      clock: this.clock,
      logger: this.logger,
    })
  }

  /** Acquire the run lock, validate the chain, load cases and recover the executor. */
  async open() {
    ensureDir(path.join(this.dir, 'cases'))
    ensureDir(path.join(this.dir, 'snapshots'))
    await this.store.open()
    await this.caseManager.load()
    const recovered = this.executor.recover()
    if (this.store.repaired !== null) {
      this.store.append({
        type: 'watch/recovered',
        actor: 'system',
        payload: { repaired: this.store.repaired, recovered },
      })
    }
    return { repaired: this.store.repaired, recovered }
  }

  /**
   * Arm supervision of a live run.
   * @param {{ mode?: 'observe'|'guard', supervisor?: boolean }} [options]
   */
  async arm(options = {}) {
    if (this.state !== 'arming') throw fail('ALREADY_ARMED', `run ${this.runId} is already armed`)
    const requestedMode = options.mode ?? this.config.mode
    if (requestedMode === 'supervised') {
      throw fail('SUPERVISOR_UNAVAILABLE', 'M1 is guard-only: the watch officer runtime is not part of this build')
    }
    if (requestedMode !== 'observe' && requestedMode !== 'guard') throw fail('INVALID_MODE', `unknown mode ${String(requestedMode)}`)

    const health = await this.ports.swarm.health()
    if (health.ok !== true) {
      this.state = 'failed'
      this.failedReason = `swarm health check failed: ${String(health.error ?? health.status)}`
      throw fail('SWARM_UNAVAILABLE', this.failedReason)
    }
    const run = await this.ports.swarm.run(this.runId)
    if (run.ok !== true || run.data === null || typeof run.data !== 'object') {
      this.state = 'failed'
      this.failedReason = `swarm run ${this.runId} is not readable: ${String(run.error ?? run.status)}`
      throw fail('RUN_NOT_FOUND', this.failedReason)
    }
    const status = String(/** @type {any} */ (run.data).status ?? 'unknown')
    if (status !== 'running' && status !== 'paused') {
      this.state = 'failed'
      this.failedReason = `swarm run ${this.runId} is ${status}`
      throw fail('RUN_NOT_RUNNING', this.failedReason)
    }

    this.mode = requestedMode === 'guard' && this.config.http.token === '' ? 'observe' : requestedMode
    const primed = await this.probe.prime(this.runId)
    if (!primed.ok) {
      this.state = 'failed'
      this.failedReason = primed.error ?? 'swarm is not readable'
      throw fail('SWARM_UNAVAILABLE', this.failedReason)
    }

    const budget = Number(this.probe.snapshot(this.runId)?.budget?.limit ?? 0)
    const reserve = budget > 0
      ? Math.round(clamp(budget * this.config.supervisor.reserveRatio, 0, Math.min(this.config.supervisor.maxReserveTokens, budget * 0.2)))
      : 0
    const event = this.store.append({
      type: 'watch/armed',
      actor: 'human',
      generation: 1,
      payload: {
        mode: this.mode,
        requestedMode,
        runId: this.runId,
        reserve,
        supervisor: 'unavailable-m1',
        sampling: { ...this.config.sampling },
        capabilities: { guard: this.mode === 'guard', write: this.config.http.token !== '' },
      },
    })
    this.armedAt = event.at
    this.state = 'watching'
    this.#writeSnapshot()
    const interval = Math.max(200, this.config.sampling.swarmEventMs)
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.#recordError(error))
    }, interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    await this.tick()
    return {
      runId: this.runId,
      mode: this.mode,
      state: this.state,
      armed: true,
      armedAt: this.armedAt,
      reserve,
    }
  }

  /** One deterministic supervision tick. Overlapping ticks are dropped, not queued. */
  async tick(now = this.clock()) {
    if (this.state !== 'watching' && this.state !== 'degraded') return
    if (this.ticking) return
    this.ticking = true
    try {
      const sampled = await this.probe.tick(this.runId, now)
      const snapshot = sampled.snapshot
      const signals = this.#signals(snapshot, now)
      const reconciled = this.caseManager.reconcile({ signals, snapshot, now })
      if (reconciled.opened.length > 0) {
        this.logger?.info?.(`[overwatch] opened ${reconciled.opened.length} case(s) for ${this.runId}`)
      }

      this.guardState.interventions = this.executor.interventions
      this.guardState.throttle = this.throttle
      const evaluation = evaluateGuard({
        snapshot,
        cases: this.caseManager,
        state: this.guardState,
        config: this.config,
        runId: this.runId,
        now,
      })
      for (const plan of evaluation.plans) {
        const record = this.caseManager.get(plan.caseId)
        const evidenceIds = new Set((record?.evidence ?? []).map(entry => String(entry.id)))
        const outcome = await this.executor.executePlan(plan, { runId: this.runId, evidenceIds })
        this.guardState.lastActions.set(`${plan.caseId}:${plan.kind}`, now)
        if (outcome.duplicate === true) continue
        this.caseManager.recordAction(plan.caseId, {
          id: outcome.actionId ?? `act_${plan.caseId}_${plan.kind}`,
          kind: plan.kind,
          state: outcome.ok ? 'verified' : (outcome.code ?? 'failed'),
          severity: plan.severity,
          detail: outcome.requiresHuman === true ? 'requires_human' : (outcome.reason ?? null),
        })
        if (outcome.ok === true) this.#afterAction(plan, outcome, now)
        else if (outcome.requiresHuman === true) {
          this.caseManager.recordDecision(plan.caseId, {
            generation: record?.generation ?? 1,
            actor: 'guard',
            verdict: 'requires_human',
            action: plan.kind,
            reason: outcome.reason ?? 'authorization requires a human',
          })
        }
      }
      const caseState = snapshot.status === 'running' || snapshot.status === 'paused'
      if (this.state === 'degraded' && caseState && sampled.freshness.swarm.ok) this.state = 'watching'
      if (!sampled.freshness.swarm.ok && this.state === 'watching') this.state = 'degraded'
      for (const notice of evaluation.notices) this.#notice(notice, now)
      this.#maybeSample(snapshot, now)
      this.#writeSnapshot()
    } catch (error) {
      // A single bad tick must not kill supervision; repeated failures make the
      // supervisor visible through `watch/error` and the health endpoint.
      this.#recordError(error)
      this.state = 'degraded'
    } finally {
      this.ticking = false
    }
  }

  /**
   * @param {any} snapshot
   * @param {number} now
   * @returns {import('./signals.js').Signal[]}
   */
  #signals(snapshot, now) {
    const budget = snapshot?.budget ?? {}
    const signals = evaluateSnapshot({
      now,
      budget: {
        used: Number(budget.spent ?? 0),
        limit: Number(budget.limit ?? 0),
        scope: 'run',
        ref: { runId: this.runId },
        at: snapshot.asOf,
      },
      run: {
        status: String(snapshot.status ?? 'unknown'),
        lastEventAt: String(snapshot.lastEventAt ?? snapshot.asOf),
        ref: { runId: this.runId },
      },
      eventGap: snapshot.eventGap ?? undefined,
    }, this.config)

    for (const member of snapshot.members ?? []) {
      if (typeof member.context === 'number') {
        const signal = contextPressureSignal(
          { ratio: member.context, sessionId: member.childId ?? member.id, at: member.pressureAt ?? snapshot.asOf },
          this.config.thresholds,
        )
        if (signal !== null) {
          signal.evidence.ref = { memberId: member.id, sessionId: member.childId }
          signals.push(signal)
        }
      }
      if (typeof member.failures === 'number' && member.failures >= this.config.thresholds.failureStreak) {
        const signal = failureStreakSignal(
          { failures: member.failures, lastFailureAt: member.pressureAt ?? snapshot.asOf, ref: { memberId: member.id, sessionId: member.childId } },
          this.config.thresholds,
        )
        if (signal !== null) signals.push(signal)
      }
    }
    // A run that is still open but silent for the stall window is worth a case
    // even though the guard does not act on it in M1.
    const stall = stallSignal({
      status: String(snapshot.status ?? 'unknown'),
      lastEventAt: String(snapshot.lastEventAt ?? snapshot.asOf),
      now,
      ref: { runId: this.runId },
    }, this.config.thresholds)
    if (stall !== null) signals.push(stall)
    return signals
  }

  /** @param {import('./guard.js').GuardPlan} plan @param {any} outcome @param {number} now */
  #afterAction(plan, outcome, now) {
    if (plan.kind === 'throttle') {
      const minutes = Number(plan.params.minutes ?? this.config.policy.throttleMinutes)
      this.throttle = {
        active: true,
        actionId: String(outcome.actionId),
        caseId: plan.caseId,
        dueAt: now + minutes * 60_000,
        minutes,
      }
      this.caseManager.setState(plan.caseId, 'verifying')
      return
    }
    if (plan.kind === 'pause') {
      this.caseManager.setState(plan.caseId, 'verifying')
      this.caseManager.recordDecision(plan.caseId, {
        generation: this.caseManager.get(plan.caseId)?.generation ?? 1,
        actor: 'guard',
        verdict: 'paused',
        action: 'pause',
        reason: 'hard pause; a human must resume',
      })
      return
    }
    if (plan.kind === 'abort') {
      this.caseManager.close(plan.caseId, 'escalated', 'run aborted by the deterministic guard')
      return
    }
    if (plan.kind === 'resume') {
      this.throttle = null
      this.caseManager.close(plan.caseId, 'mitigated', 'throttle window elapsed and the resume was verified')
    }
  }

  /**
   * @param {{ code: string, reason: string, caseId?: string }} notice
   * @param {number} now
   */
  #notice(notice, now) {
    const key = `${notice.code}:${notice.caseId ?? '-'}`
    const last = this.noticeAt.get(key) ?? 0
    if (now - last < 60_000) return
    this.noticeAt.set(key, now)
    this.store.append({
      type: 'watch/guard/notice',
      actor: 'guard',
      payload: { code: notice.code, reason: notice.reason, caseId: notice.caseId ?? null },
    })
  }

  /** @param {any} snapshot @param {number} now */
  #maybeSample(snapshot, now) {
    const budgetRatio = Number(snapshot?.budget?.ratio ?? 0)
    const status = String(snapshot?.status ?? 'unknown')
    const significant = Math.abs(budgetRatio - this.lastSampleRatio) >= 0.02 || status !== this.lastSampleStatus
    if (!significant && now - this.lastSampleAt < 60_000) return
    this.lastSampleAt = now
    this.lastSampleRatio = budgetRatio
    this.lastSampleStatus = status
    this.store.append({
      type: 'watch/sample',
      actor: 'guard',
      payload: {
        status,
        round: snapshot?.round ?? 0,
        budget: { limit: snapshot?.budget?.limit ?? 0, spent: snapshot?.budget?.spent ?? 0, ratio: Number(budgetRatio.toFixed(4)) },
        cases: { open: this.caseManager.openCount() },
        freshness: snapshot?.freshness ?? null,
      },
    })
  }

  #writeSnapshot() {
    const snapshot = this.probe.snapshot(this.runId)
    if (snapshot === null) return
    const record = {
      schemaVersion: 1,
      runId: this.runId,
      asOf: new Date(this.clock()).toISOString(),
      state: this.state,
      mode: this.mode,
      armedAt: this.armedAt,
      snapshot,
      cases: { open: this.caseManager.openCount(), bySeverity: this.#caseCounts() },
      throttle: this.throttle,
      interventions: this.executor.interventions,
    }
    try {
      atomicWriteJson(path.join(this.dir, 'snapshots', 'last.json'), record)
    } catch (error) {
      this.logger?.warn?.(`[overwatch] could not write snapshot: ${messageOf(error)}`)
    }
  }

  #caseCounts() {
    const counts = { L1: 0, L2: 0, L3: 0, L4: 0 }
    for (const record of this.caseManager.list({ state: 'open' })) {
      if (counts[record.severity] !== undefined) counts[record.severity] += 1
    }
    return counts
  }

  /** @param {unknown} error */
  #recordError(error) {
    const now = this.clock()
    if (now - this.lastErrorAt < 60_000) return
    this.lastErrorAt = now
    try {
      this.store.append({
        type: 'watch/error',
        actor: 'system',
        payload: { code: errorCode(error), message: messageOf(error).slice(0, 300) },
      })
    } catch {
      // The store may already be closed or full; health still reports the state.
    }
  }

  /**
   * @param {string} reason
   */
  async disarm(reason = 'disarmed') {
    if (this.state === 'disarmed' || this.state === 'disarming') return { runId: this.runId, state: 'disarmed', closedCases: [] }
    this.state = 'disarming'
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const closed = this.caseManager.closeAll('abandoned', `supervision disarmed: ${reason}`)
    this.throttle = null
    this.store.append({
      type: 'watch/disarmed',
      actor: 'human',
      payload: { reason: String(reason).slice(0, 300), closedCases: closed.map(record => record.id) },
    })
    this.state = 'disarmed'
    this.disarmedAt = new Date(this.clock()).toISOString()
    this.#writeSnapshot()
    this.probe.close(this.runId)
    this.store.fsync()
    this.store.close()
    return { runId: this.runId, state: 'disarmed', closedCases: closed.map(record => record.id), disarmedAt: this.disarmedAt }
  }

  /** @param {{ state?: string, limit?: number }} [query] */
  cases(query = {}) {
    return this.caseManager.list(query)
  }

  /** @param {string} caseId */
  caseDetail(caseId) {
    const record = this.caseManager.get(caseId)
    if (record === null) return null
    return { case: record, timeline: this.timeline({ limit: 50 }).events }
  }

  /**
   * Merge watch events and swarm events into one timeline. The cursor is the
   * index into the merged list, which is stable while the lists only append.
   * @param {{ since?: number, limit?: number }} [query]
   */
  timeline(query = {}) {
    const since = Math.max(0, Math.trunc(query.since ?? 0))
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
    const watch = this.store.read({ since: 0 }).map(event => ({
      seq: event.seq,
      source: 'watch',
      type: event.type,
      at: event.at,
      actor: event.actor,
      summary: summarizeWatchEvent(event),
    }))
    const swarm = this.probe.events(this.runId, { since: 0, limit: 1_000 }).map(event => ({
      seq: event.seq,
      source: 'swarm',
      type: event.type,
      at: event.at,
      actor: event.actor,
      summary: event.summary,
    }))
    const rank = { swarm: 0, pressure: 1, fish: 2, watch: 3 }
    const merged = [...swarm, ...watch].sort((a, b) => {
      const byTime = String(a.at).localeCompare(String(b.at))
      if (byTime !== 0) return byTime
      const byRank = (rank[a.source] ?? 9) - (rank[b.source] ?? 9)
      return byRank !== 0 ? byRank : a.seq - b.seq
    })
    const events = merged.slice(since, since + limit)
    return { events, nextSince: since + events.length, total: merged.length }
  }

  /**
   * @param {string} caseId
   * @param {string} [note]
   */
  acknowledge(caseId, note = '') {
    const record = this.caseManager.get(caseId)
    if (record === null) throw fail('CASE_NOT_FOUND', `case ${caseId} not found`)
    if (record.state === 'closed') throw fail('CASE_CLOSED', `case ${caseId} is already closed`)
    this.caseManager.setState(caseId, 'acknowledged')
    this.caseManager.recordDecision(caseId, {
      generation: record.generation,
      actor: 'human',
      verdict: 'acknowledged',
      note: String(note).slice(0, 300),
      at: new Date(this.clock()).toISOString(),
    })
    this.store.append({
      type: 'watch/human_action',
      actor: 'human',
      causationRef: { kind: 'case', caseId },
      payload: { action: 'ack', caseId, note: String(note).slice(0, 300) },
    })
    return this.caseManager.get(caseId)
  }

  /** Live read model for the panel and tools. */
  snapshot() {
    const snapshot = this.probe.snapshot(this.runId)
    const budget = snapshot?.budget ?? { limit: 0, spent: 0, ratio: 0 }
    const limit = Number(budget.limit ?? 0)
    const reserveLimit = limit > 0
      ? Math.round(clamp(limit * this.config.supervisor.reserveRatio, 0, Math.min(this.config.supervisor.maxReserveTokens, limit * 0.2)))
      : 0
    return {
      runId: this.runId,
      armed: this.state === 'watching' || this.state === 'degraded' || this.state === 'disarming',
      state: this.state,
      mode: this.mode,
      goal: snapshot?.goal ?? null,
      status: snapshot?.status ?? 'unknown',
      snapshot,
      freshness: snapshot?.freshness ?? this.probe.freshness(this.runId),
      budget: {
        limit,
        spent: Number(budget.spent ?? 0),
        ratio: Number((limit > 0 ? Number(budget.spent ?? 0) / limit : 0).toFixed(4)),
        reserve: reserveLimit,
        supervisorUsed: 0,
      },
      cases: { open: this.caseManager.openCount(), bySeverity: this.#caseCounts(), total: this.caseManager.list({ state: 'all', limit: 500 }).length },
      throttle: this.throttle,
      interventions: this.executor.interventions,
      lock: { held: this.store.opened, name: `watch-${this.runId}` },
      lastEventAt: snapshot?.lastEventAt ?? null,
      armedAt: this.armedAt,
      disarmedAt: this.disarmedAt,
      failedReason: this.failedReason,
    }
  }

  health() {
    const verify = this.store.verify()
    return {
      runId: this.runId,
      state: this.state,
      mode: this.mode,
      lock: { held: this.store.opened },
      log: { ok: verify.ok, count: verify.count, lastHash: verify.lastHash, error: verify.error },
      cases: { open: this.caseManager.openCount() },
      freshness: this.probe.freshness(this.runId),
      throttle: this.throttle,
      interventions: this.executor.interventions,
    }
  }

  /** Markdown report for `watch_report` and the panel export. */
  report() {
    const view = this.snapshot()
    const cases = this.caseManager.list({ state: 'all', limit: 100 })
    const lines = [
      `# Overwatch report · ${this.runId}`,
      '',
      `- state: ${view.state} (${view.mode})`,
      `- swarm status: ${view.status}`,
      `- budget: ${view.budget.spent}/${view.budget.limit} (${(view.budget.ratio * 100).toFixed(1)}%)`,
      `- cases: ${cases.length} (open ${view.cases.open})`,
      `- guard interventions: ${view.interventions}`,
      `- watch log: ${view.state === 'disarmed' ? 'closed' : 'live'}`,
      '',
      '| case | severity | code | state | opened | closed |',
      '| --- | --- | --- | --- | --- | --- |',
      ...cases.map(record => `| ${record.id} | ${record.severity} | ${record.code} | ${record.state} | ${record.openedAt} | ${record.closeReason ?? ''} |`),
    ]
    return lines.join('\n')
  }

  /** Force-close without the full disarms path (used when the plugin unloads). */
  close() {
    try {
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      if (this.store.opened) this.store.close()
    } catch {
      // best effort on unload
    }
  }
}

/** @param {any} event */
function summarizeWatchEvent(event) {
  const payload = event?.payload ?? {}
  const id = payload.caseId ?? payload.actionId ?? payload.runId ?? null
  const code = payload.code ?? payload.kind ?? null
  const bits = [event.type]
  if (id !== null) bits.push(String(id))
  if (code !== null) bits.push(String(code))
  if (payload.severity !== undefined) bits.push(String(payload.severity))
  return bits.join(' ')
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} error */
function errorCode(error) {
  const code = /** @type {any} */ (error)?.code
  return typeof code === 'string' ? code : 'INTERNAL'
}
