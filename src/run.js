/**
 * Per-run supervisor: one writer, one sampler, one action queue.
 *
 * The supervisor is the unit that `watch_arm` creates. It owns the run's watch
 * log (hash chain), the case manager, the probe, the deterministic guard and the
 * executor. It deliberately contains no model: M1 is guard-only, and the watch
 * officer runtime arrives in M2 behind the same interface.
 * @module dsh-overwatch/run
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildCaseCard, buildEvidence } from './card.js'
import { CaseManager } from './cases.js'
import { Executor } from './executor.js'
import { evaluateGuard } from './guard.js'
import { Probe } from './probe.js'
import { evaluateSnapshot, contextPressureSignal, failureStreakSignal, stallSignal } from './signals.js'
import { WatchStore } from './store.js'
import { atomicWriteJson, clamp, ensureDir, sha256 } from './util.js'
import { WatchOfficer } from './watch.js'

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
    this.ctx = options.ctx ?? { get: () => undefined }
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
    /** Test seam: the real factory builds a WatchOfficer over ctx.subagents. */
    this.watchFactory = options.watchFactory ?? (watchOptions => new WatchOfficer(watchOptions))
    /** @type {any} */
    this.parentAgent = null
    this.reserve = 0
    /** @type {WatchOfficer | null} */
    this.watch = null
    /** @type {string[]} */
    this.watchQueue = []
    /** @type {Set<string>} */
    this.watchedCases = new Set()
    /** @type {Set<string>} */
    this.seenAgents = new Set()
    this.watchFailed = false
    this.watchErrors = 0
    this.lastWakeAt = 0
    /** @type {number[]} */
    this.wakeTimes = []
    this.usage = { input: 0, output: 0, total: 0, calls: 0 }
    /** @type {Set<string>} */
    this.usageKeys = new Set()
    this.shiftSeq = 0
    /** @type {{ id: string, path: string, at: string } | null} */
    this.lastShift = null
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
   * @param {{ mode?: 'observe'|'guard'|'supervised', parentAgent?: any }} [options]
   */
  async arm(options = {}) {
    if (this.state !== 'arming') throw fail('ALREADY_ARMED', `run ${this.runId} is already armed`)
    const requestedMode = options.mode ?? this.config.mode
    if (!['observe', 'guard', 'supervised'].includes(requestedMode)) throw fail('INVALID_MODE', `unknown mode ${String(requestedMode)}`)
    if (requestedMode === 'supervised') {
      if (!this.config.supervisor.enabled) throw fail('SUPERVISOR_DISABLED', 'supervisor.enabled is false')
      if (this.config.http.token === '') throw fail('WRITE_DISABLED', 'supervised arm needs http.token for executable decisions')
      if (options.parentAgent === undefined || options.parentAgent === null) throw fail('AGENT_REQUIRED', 'supervised arm needs the live root agent as the watch officer parent')
      if (this.ctx.get?.('subagents') === undefined || this.ctx.get?.('subagents') === null) {
        throw fail('SUBAGENTS_UNAVAILABLE', 'the subagents service is not mounted; the watch officer cannot start')
      }
    }

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
    this.reserve = reserve
    this.parentAgent = options.parentAgent ?? null
    this.executor.policy.mode = this.mode
    if (this.mode === 'supervised') this.#checkCapacity(primed.snapshot)
    if (this.mode === 'supervised') {
      const name = `ow-${sha256(`${this.runId}:${Date.now()}:${Math.random()}`).slice(0, 12)}`
      this.watch = this.watchFactory({
        ctx: this.ctx,
        runId: this.runId,
        name,
        parentAgent: this.parentAgent,
        config: this.config,
        logger: this.logger,
        callbacks: {
          card: caseId => this.#caseCard(caseId),
          evidence: (caseId, refs) => this.#caseEvidence(caseId, refs),
          decide: (decision, meta) => this.#handleWatchDecision(decision, meta),
          record: (type, payload) => this.#recordWatchEvent(type, payload),
        },
      })
    }
    const event = this.store.append({
      type: 'watch/armed',
      actor: 'human',
      generation: 1,
      payload: {
        mode: this.mode,
        requestedMode,
        runId: this.runId,
        reserve,
        supervisor: this.mode === 'supervised' ? 'lazy' : 'unavailable-m1',
        watchName: this.watch?.name ?? null,
        sampling: { ...this.config.sampling },
        capabilities: { guard: this.mode !== 'observe', supervisor: this.mode === 'supervised', write: this.config.http.token !== '' },
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
      this.#scheduleWatch(snapshot, now)

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

  /**
   * Cheap pre-flight for supervised arm: one watch child plus every non-queen
   * member must fit in the process-wide subagent capacity.
   * @param {any} snapshot
   */
  #checkCapacity(snapshot) {
    let capacity
    try {
      capacity = this.ctx.get?.('subagents')?.config?.maxActiveSubagents?.get?.()
    } catch (error) {
      this.logger?.warn?.(`[overwatch] could not read maxActiveSubagents: ${messageOf(error)}`)
      return
    }
    const members = (snapshot?.members ?? []).filter(member => member.role !== 'queen' && member.status !== 'left' && member.status !== 'lost')
    if (typeof capacity === 'number' && Number.isFinite(capacity) && members.length + 1 > capacity) {
      this.state = 'failed'
      this.failedReason = `run has ${members.length} non-queen member(s); a watch officer needs capacity ${members.length + 1}, but maxActiveSubagents is ${capacity}`
      throw fail('CAPACITY_CONFLICT', this.failedReason)
    }
  }

  /**
   * Serial `agent/created` hook forwarded by the service. Must stay synchronous:
   * the child's first model request waits for this listener.
   * @param {any} agent
   */
  handleAgentCreated(agent) {
    if (this.watch === null) return false
    try {
      const claimed = this.watch.handleAgentCreated(agent)
      if (!claimed && agent !== null && agent !== undefined) {
        const id = String(agent.id ?? '')
        if (id !== '' && !this.seenAgents.has(id)) {
          this.seenAgents.add(id)
          let names = null
          try {
            names = this.ctx.get?.('subagents')?.namesOf?.(agent) ?? null
          } catch (error) {
            names = { error: messageOf(error) }
          }
          this.store.append({
            type: 'watch/agent/ignored',
            actor: 'system',
            payload: {
              agentId: id,
              origin: agent.session?.header?.origin ?? null,
              keys: Object.keys(agent),
              options: agent.options ?? null,
              runtimeContext: summar(agent.runtimeContext),
              scopeKeys: agent.scope === null || agent.scope === undefined ? null : Object.keys(agent.scope),
              systemPrompt: typeof agent.systemPrompt === 'string' ? agent.systemPrompt.slice(0, 500) : null,
              phase: agent.phase ?? null,
              names,
              header: agent.session?.header ?? null,
              watchName: this.watch.name,
            },
          })
        }
      }
      return claimed
    } catch (error) {
      this.#recordError(error)
      return false
    }
  }

  /**
   * Fold the watch child's turn usage into the supervisor ledger. Called for
   * every session event by the service; other sessions are ignored.
   * @param {string} sessionId
   * @param {any} event
   */
  recordUsage(sessionId, event) {
    if (this.watch === null || this.watch.childId === null) return
    if (String(sessionId) !== this.watch.childId) return
    if (event?.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (usage === undefined || usage === null) return
    const key = event.data?.message?.id ?? `${String(event.data?.turn)}:${String(event.data?.step)}`
    if (this.usageKeys.has(key)) return
    this.usageKeys.add(key)
    const input = Number(usage.inputTokens ?? 0)
    const output = Number(usage.outputTokens ?? 0)
    const total = Number(usage.totalTokens ?? input + output)
    this.usage.input += Number.isFinite(input) ? input : 0
    this.usage.output += Number.isFinite(output) ? output : 0
    this.usage.total += Number.isFinite(total) ? total : 0
    this.usage.calls += 1
  }

  /**
   * Enqueue L2+ cases for the watch officer and pump the (serial) wake queue.
   * @param {any} snapshot
   * @param {number} now
   */
  #scheduleWatch(snapshot, now) {
    if (this.watch === null || this.watchFailed) return
    for (const record of this.caseManager.list({ state: 'open' })) {
      if (record.severity === 'L0' || record.severity === 'L1') continue
      if (this.watchedCases.has(record.id)) continue
      if (this.watchQueue.length >= 3) {
        this.#watchNotice({ code: 'watch_backlog', reason: 'watch wake queue is full; guard keeps handling the run', caseId: record.id }, now)
        break
      }
      this.watchedCases.add(record.id)
      this.watchQueue.push(record.id)
    }
    this.#pumpWatch(now)
  }

  /** @param {number} now */
  #pumpWatch(now) {
    if (this.watch === null || this.watchFailed) return
    if (this.watch.pending !== null) return
    if (this.watchQueue.length === 0) return
    const caseId = this.watchQueue.shift()
    const record = this.caseManager.get(caseId)
    if (record === null || record.state === 'closed') {
      this.#pumpWatch(now)
      return
    }
    const budget = this.#wakeBudget(now)
    if (!budget.ok) {
      this.#watchNotice({ code: budget.code, reason: budget.reason, caseId }, now)
      return
    }
    const card = this.#caseCard(caseId)
    if (card === null) return
    this.wakeTimes.push(now)
    this.lastWakeAt = now
    this.store.append({
      type: 'watch/wake',
      actor: 'system',
      causationRef: { kind: 'case', caseId },
      payload: {
        caseId,
        generation: record.generation,
        wakeIndex: this.watch.wakes + 1,
        budgetLeft: budget.left,
        severity: record.severity,
        code: record.code,
      },
    })
    void this.watch.wake({ caseId, generation: record.generation, card, timeoutMs: this.config.supervisor.wakeTimeoutMs })
      .then(outcome => this.#onWake(caseId, record.generation, outcome))
      .catch(error => {
        this.watchErrors += 1
        this.#recordError(error)
      })
      .finally(() => {
        this.#pumpWatch(this.clock())
      })
  }

  /** @param {number} now */
  #wakeBudget(now) {
    if (this.watch === null) return { ok: false, code: 'supervisor_unavailable', reason: 'watch officer is not started' }
    if (this.watch.wakes >= this.config.supervisor.maxWakes) {
      return { ok: false, code: 'supervisor_budget_exhausted', reason: `maxWakes ${this.config.supervisor.maxWakes} reached` }
    }
    this.wakeTimes = this.wakeTimes.filter(at => now - at < 3_600_000)
    if (this.wakeTimes.length >= this.config.supervisor.maxWakesPerHour) {
      return { ok: false, code: 'supervisor_rate_limited', reason: `maxWakesPerHour ${this.config.supervisor.maxWakesPerHour} reached` }
    }
    if (this.reserve <= 0) {
      return { ok: false, code: 'supervisor_budget_exhausted', reason: 'no supervisor token reserve was established at arm time' }
    }
    const left = this.reserve - this.usage.total
    const estimate = Math.min(this.config.supervisor.maxTokensPerWake, left)
    if (left <= 0 || estimate < 1_000) {
      return { ok: false, code: 'supervisor_budget_exhausted', reason: `reserve exhausted (${this.usage.total}/${this.reserve} tokens)` }
    }
    return { ok: true, left }
  }

  /** @param {string} caseId */
  #caseCard(caseId) {
    const record = this.caseManager.get(caseId)
    if (record === null) return null
    return buildCaseCard({
      record,
      snapshot: this.probe.snapshot(this.runId) ?? {},
      events: this.probe.events(this.runId, { since: 0, limit: 500 }),
      config: this.config,
      reserve: this.reserve,
      spent: this.usage.total,
    })
  }

  /** @param {string} caseId @param {string[]} refs */
  #caseEvidence(caseId, refs) {
    const record = this.caseManager.get(caseId)
    if (record === null) return { items: [], bytes: 0, truncated: false }
    return buildEvidence({
      record,
      refs,
      events: this.probe.events(this.runId, { since: 0, limit: 500 }),
      maxBytes: this.config.supervisor.maxEvidenceBytes,
    })
  }

  /**
   * Called by watch_decide. Validates/authorizes/executes through the same
   * executor the guard uses, then records the action on the case.
   * @param {any} decision
   * @param {{ caseId: string, generation: number }} meta
   */
  async #handleWatchDecision(decision, meta) {
    const record = this.caseManager.get(meta.caseId)
    if (record === null) return { ok: false, code: 'CASE_NOT_FOUND', message: 'case not found' }
    if (record.state === 'closed') return { ok: false, code: 'CASE_CLOSED', message: 'case is already closed' }
    if (record.generation !== meta.generation) return { ok: false, code: 'STALE_GENERATION', message: 'case generation changed; refusing a stale decision' }
    const evidenceIds = new Set(record.evidence.map(entry => String(entry.id)))
    const outcome = await this.executor.execute(decision, {
      caseId: meta.caseId,
      evidenceIds,
      hardLimit: record.severity === 'L4',
      runId: this.runId,
    })
    if (typeof outcome.actionId === 'string') {
      this.caseManager.recordAction(meta.caseId, {
        id: outcome.actionId,
        kind: String(decision.action),
        state: outcome.ok === true ? 'verified' : (outcome.code ?? 'failed'),
        detail: outcome.requiresHuman === true ? 'requires_human' : (outcome.reason ?? null),
      })
    }
    return outcome
  }

  /**
   * @param {string} caseId
   * @param {number} generation
   * @param {any} outcome
   */
  #onWake(caseId, generation, outcome) {
    const now = this.clock()
    const record = this.caseManager.get(caseId)
    if (record === null) return
    if (outcome.status === 'decided') {
      this.watchErrors = 0
      const decision = outcome.decision ?? {}
      const result = outcome.outcome ?? {}
      this.store.append({
        type: result.ok === true ? 'watch/decision' : 'watch/decision/rejected',
        actor: 'watch',
        causationRef: { kind: 'case', caseId },
        payload: {
          caseId,
          generation,
          action: decision.action ?? null,
          confidence: decision.confidence ?? null,
          reason: typeof decision.reason === 'string' ? decision.reason.slice(0, 300) : null,
          accepted: result.ok === true,
          code: result.code ?? null,
          requiresHuman: result.requiresHuman === true,
          actionId: result.actionId ?? null,
        },
      })
      this.caseManager.recordDecision(caseId, {
        generation,
        actor: 'watch',
        verdict: String(decision.action ?? 'unknown'),
        action: decision.action ?? null,
        confidence: decision.confidence ?? null,
        reason: typeof decision.reason === 'string' ? decision.reason.slice(0, 300) : null,
        accepted: result.ok === true,
        code: result.code ?? null,
      })
      this.store.append({
        type: 'watch/usage',
        actor: 'system',
        payload: { caseId, spent: this.usage.total, reserve: this.reserve, calls: this.usage.calls },
      })
      if (result.ok === true) {
        this.#applyWatchOutcome(caseId, decision, result, now)
      } else if (result.requiresHuman === true) {
        this.#watchNotice({ code: 'requires_human', reason: String(result.reason ?? 'decision needs a human'), caseId }, now)
      } else {
        this.#watchNotice({ code: 'watch_decision_rejected', reason: String(result.code ?? 'rejected'), caseId }, now)
      }
      return
    }
    if (outcome.status === 'timeout' || outcome.status === 'no_decision') {
      this.store.append({
        type: 'watch/wake/timeout',
        actor: 'system',
        causationRef: { kind: 'case', caseId },
        payload: { caseId, generation, status: outcome.status, waitedMs: Math.max(0, now - this.lastWakeAt), stopReason: outcome.stopReason ?? null },
      })
      this.caseManager.recordDecision(caseId, { generation, actor: 'watch', verdict: 'timeout', accepted: false, status: outcome.status })
      this.#watchNotice({ code: 'watch_timeout', reason: `watch officer produced no decision (${outcome.status})`, caseId }, now)
      if (this.watch !== null && this.watch.timeouts >= 2) {
        this.watchFailed = true
        this.store.append({ type: 'watch/degraded', actor: 'system', payload: { reason: 'two wake timeouts; falling back to the deterministic guard' } })
      }
      return
    }
    this.watchErrors += 1
    this.store.append({
      type: 'watch/error',
      actor: 'system',
      causationRef: { kind: 'case', caseId },
      payload: { caseId, status: outcome.status, error: outcome.error ?? null, code: outcome.code ?? null },
    })
    if (this.watchErrors >= 2) {
      this.watchFailed = true
      this.store.append({ type: 'watch/degraded', actor: 'system', payload: { reason: 'two consecutive watch failures; falling back to the deterministic guard' } })
    }
  }

  /**
   * @param {string} caseId
   * @param {any} decision
   * @param {any} result
   * @param {number} now
   */
  #applyWatchOutcome(caseId, decision, result, now) {
    const action = String(decision.action ?? '')
    if (action === 'throttle') {
      const minutes = Math.max(1, Math.trunc(Number(decision.params?.minutes ?? this.config.policy.throttleMinutes)))
      this.throttle = {
        active: true,
        actionId: String(result.actionId ?? ''),
        caseId,
        dueAt: now + minutes * 60_000,
        minutes,
      }
      this.caseManager.setState(caseId, 'verifying')
      this.store.append({ type: 'watch/throttle/started', actor: 'watch', payload: { caseId, actionId: result.actionId ?? null, minutes } })
      return
    }
    if (action === 'pause') {
      this.caseManager.setState(caseId, 'verifying')
      return
    }
    if (action === 'abort') {
      this.caseManager.close(caseId, 'escalated', 'watch officer aborted the run')
      return
    }
    if (action === 'escalate') {
      this.caseManager.close(caseId, 'escalated', 'watch officer escalated to a human')
      return
    }
    if (action === 'coach' || action === 'notice') {
      this.caseManager.close(caseId, 'mitigated', `watch officer issued ${action}`)
    }
  }

  /** @param {string} type @param {any} payload */
  #recordWatchEvent(type, payload) {
    try {
      this.store.append({ type, actor: 'watch', payload })
    } catch {
      // The store may be full or closing; health and the wake result still report.
    }
  }

  /**
   * @param {{ code: string, reason: string, caseId?: string }} notice
   * @param {number} now
   */
  #watchNotice(notice, now) {
    const key = `watch:${notice.code}:${notice.caseId ?? '-'}`
    const last = this.noticeAt.get(key) ?? 0
    if (now - last < 60_000) return
    this.noticeAt.set(key, now)
    this.store.append({
      type: 'watch/notice',
      actor: 'watch',
      payload: { code: notice.code, reason: notice.reason, caseId: notice.caseId ?? null },
    })
  }

  /**
   * Write the shift handover and its log event. Called on disarm with the watch
   * officer's last status, because the officer is disposed before the store closes.
   * @param {string} reason
   * @param {number} now
   * @param {any} [officer]
   */
  #writeShift(reason, now, officer = null) {
    const view = this.snapshot()
    this.shiftSeq += 1
    const id = `shift-${String(this.shiftSeq).padStart(4, '0')}`
    const cases = this.caseManager.list({ state: 'all', limit: 100 })
    const lines = [
      `# Watch shift ${id} · ${this.runId}`,
      '',
      `- window: ${view.armedAt ?? 'unknown'} -> ${new Date(now).toISOString()}`,
      `- mode: ${view.mode}  state: ${view.state}  reason: ${reason}`,
      `- swarm: ${view.status}`,
      `- budget B/W/S/E: ${view.budget.limit} / ${view.budget.spent} / ${this.usage.total} / ${view.budget.spent + this.usage.total}`,
      `- watch officer: ${officer?.name ?? 'none'}  child: ${officer?.childId ?? 'none'}  wakes: ${officer?.wakes ?? 0}  timeouts: ${officer?.timeouts ?? 0}`,
      `- cases: ${cases.length} (open ${view.cases.open})`,
      '',
      '| case | severity | code | state | close reason |',
      '| --- | --- | --- | --- | --- |',
      ...cases.map(record => `| ${record.id} | ${record.severity} | ${record.code} | ${record.state} | ${record.closeReason ?? ''} |`),
    ]
    const text = `${lines.join('\n')}\n`
    const file = path.join(this.dir, 'shifts', `${id}.md`)
    ensureDir(path.dirname(file))
    writeFileSync(file, text, 'utf8')
    this.lastShift = { id, path: file, at: new Date(now).toISOString() }
    this.store.append({
      type: 'watch/shift',
      actor: 'system',
      payload: {
        shiftId: id,
        reason,
        window: { from: this.armedAt, to: new Date(now).toISOString() },
        summary: {
          mode: this.mode,
          budget: view.budget,
          supervisorSpent: this.usage.total,
          cases: { total: cases.length, open: view.cases.open },
          wakes: officer?.wakes ?? 0,
          timeouts: officer?.timeouts ?? 0,
        },
      },
    })
    return this.lastShift
  }

  watchStatus() {
    const officer = this.watch === null ? null : this.watch.status()
    return {
      enabled: this.mode === 'supervised',
      state: officer?.state ?? (this.mode === 'supervised' ? 'absent' : 'disabled'),
      name: officer?.name ?? null,
      childId: officer?.childId ?? null,
      wakes: officer?.wakes ?? 0,
      timeouts: officer?.timeouts ?? 0,
      errors: officer?.errors ?? this.watchErrors,
      lastError: officer?.lastError ?? null,
      activeCaseId: officer?.activeCaseId ?? null,
      reserve: this.reserve,
      spent: this.usage.total,
      remaining: Math.max(0, this.reserve - this.usage.total),
      input: this.usage.input,
      output: this.usage.output,
      calls: this.usage.calls,
      queue: this.watchQueue.length,
      failed: this.watchFailed,
      lastShift: this.lastShift,
    }
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
    /** @type {any} */
    let watchStatus = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.watch !== null) {
      try {
        watchStatus = this.watch.status()
        await this.watch.dispose()
      } catch (error) {
        this.#recordError(error)
      }
      this.watch = null
    }
    const closed = this.caseManager.closeAll('abandoned', `supervision disarmed: ${reason}`)
    this.throttle = null
    const shift = this.#writeShift(String(reason).slice(0, 300), this.clock(), watchStatus)
    this.store.append({
      type: 'watch/disarmed',
      actor: 'human',
      payload: {
        reason: String(reason).slice(0, 300),
        closedCases: closed.map(record => record.id),
        shiftId: shift?.id ?? null,
        supervisorSpent: this.usage.total,
      },
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
   * Merge swarm events, pressure samples and watch events into one timeline.
   * `since` is an opaque cursor: the first call uses 0, later calls echo the
   * previous `nextSince`. Entries are ordered by (at, source rank, seq).
   * @param {{ since?: number | string, limit?: number }} [query]
   */
  timeline(query = {}) {
    const since = query.since ?? 0
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
    const pressure = this.probe.pressureEvents(this.runId).map((sample, index) => ({
      seq: index + 1,
      source: 'pressure',
      type: 'pressure/sample',
      at: sample.at,
      actor: 'pressure',
      summary: `member=${sample.memberId} context=${typeof sample.ratio === 'number' ? sample.ratio.toFixed(2) : 'n/a'} failures=${sample.failures}`,
    }))
    const rank = { swarm: 0, pressure: 1, fish: 2, watch: 3 }
    const merged = [...swarm, ...pressure, ...watch].map(entry => ({
      ...entry,
      orderKey: `${entry.at ?? ''}|${rank[entry.source] ?? 9}|${entry.source}:${entry.seq}`,
    }))
    merged.sort((left, right) => {
      const byTime = String(left.at ?? '').localeCompare(String(right.at ?? ''))
      if (byTime !== 0) return byTime
      const byRank = (rank[left.source] ?? 9) - (rank[right.source] ?? 9)
      return byRank !== 0 ? byRank : left.seq - right.seq
    })
    let start = 0
    if (typeof since === 'string' && since !== '' && since !== '0') {
      const exact = merged.findIndex(entry => entry.orderKey === since)
      if (exact >= 0) start = exact + 1
      else {
        const next = merged.findIndex(entry => entry.orderKey > since)
        start = next < 0 ? merged.length : next
      }
    } else {
      start = Math.max(0, Math.trunc(Number(since) || 0))
    }
    const page = merged.slice(start, start + limit)
    return {
      events: page.map(({ orderKey: _orderKey, ...entry }) => entry),
      nextSince: page.at(-1)?.orderKey ?? (typeof since === 'string' ? since : 0),
      total: merged.length,
    }
  }

  /**
   * Record a fishkeeper restore intent/result. Overwatch never accepts or stores
   * the fishkeeper confirm token: the browser performs the restore, and this path
   * only records that it happened.
   * @param {any} input
   */
  recordRestore(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_RESTORE', 'restore payload must be an object')
    if (containsKey(input, 'confirmToken')) throw fail('RESTORE_TOKEN_REJECTED', 'confirmToken must never be sent to overwatch')
    const phase = input.phase
    if (phase !== 'intent' && phase !== 'result') throw fail('INVALID_PHASE', 'phase must be intent or result')
    const sourceId = validRestoreId(input.sourceId, 'sourceId')
    const checkpointId = validRestoreId(input.checkpointId, 'checkpointId')
    const payload = {
      sourceId,
      checkpointId,
      phase,
      files: normalizeRestoreFiles(input.files),
      warnings: Array.isArray(input.warnings) ? input.warnings.filter(item => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 200)) : [],
      result: normalizeRestoreResult(input.result),
    }
    this.store.append({
      type: phase === 'intent' ? 'watch/restore/intent' : 'watch/restore/result',
      actor: 'human',
      payload,
    })
    return { recorded: true, phase, sourceId, checkpointId }
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
    const computedReserve = limit > 0
      ? Math.round(clamp(limit * this.config.supervisor.reserveRatio, 0, Math.min(this.config.supervisor.maxReserveTokens, limit * 0.2)))
      : 0
    const reserveLimit = this.reserve > 0 ? this.reserve : computedReserve
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
        supervisorUsed: this.usage.total,
      },
      watch: this.watchStatus(),
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
      watch: this.watchStatus(),
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
      `- supervisor S: ${view.watch.spent}/${view.watch.reserve} tokens, ${view.watch.wakes} wake(s), ${view.watch.timeouts} timeout(s), state ${view.watch.state}`,
      `- cases: ${cases.length} (open ${view.cases.open})`,
      `- guard interventions: ${view.interventions}`,
      `- watch log: ${view.state === 'disarmed' ? 'closed' : 'live'}`,
      ...(view.watch.lastShift === null ? [] : [`- last shift: ${view.watch.lastShift.id} (${view.watch.lastShift.path})`]),
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
      void this.watch?.dispose?.()
      if (this.store.opened) this.store.close()
    } catch {
      // best effort on unload
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {number} [depth]
 */
function containsKey(value, key, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => containsKey(item, key, depth + 1))
  for (const [name, child] of Object.entries(value)) {
    if (name === key) return true
    if (containsKey(child, key, depth + 1)) return true
  }
  return false
}

/** @param {unknown} value @param {string} name */
function validRestoreId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw fail('INVALID_RESTORE', `${name} must match [A-Za-z0-9._:-]{1,200}`)
  }
  return value
}

/** @param {unknown} files */
function normalizeRestoreFiles(files) {
  if (!Array.isArray(files)) return []
  /** @type {any[]} */
  const out = []
  for (const item of files.slice(0, 50)) {
    if (typeof item === 'string') {
      out.push({ path: item.slice(0, 300) })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    out.push({
      path: String(item.path ?? '').slice(0, 300),
      action: typeof item.action === 'string' ? item.action : null,
      stale: item.stale === true,
      bytes: typeof item.bytes === 'number' && Number.isFinite(item.bytes) ? item.bytes : null,
    })
  }
  return out
}

/** @param {unknown} result */
function normalizeRestoreResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const record = /** @type {Record<string, unknown>} */ (result)
  return {
    ok: record.ok === true,
    error: typeof record.error === 'string' ? record.error.slice(0, 300) : null,
    files: Array.isArray(record.files)
      ? record.files.slice(0, 50).map(file => ({
          path: String(/** @type {any} */ (file)?.path ?? '').slice(0, 300),
          ok: /** @type {any} */ (file)?.ok === true,
          sha256: typeof /** @type {any} */ (file)?.sha256 === 'string' ? String(/** @type {any} */ (file).sha256).slice(0, 80) : null,
        }))
      : [],
  }
}

/** @param {any} event */
function summarizeWatchEvent(event) {  const payload = event?.payload ?? {}
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
