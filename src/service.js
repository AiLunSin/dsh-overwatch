/**
 * Host-side Overwatch service.
 *
 * Owns the data directory, the service-level life log, and the registry of
 * supervised runs. One process can supervise several runs; each run has its own
 * `RunSupervisor`, its own lock and its own hash chain.
 * @module dsh-overwatch/service
 */

import { existsSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readApprovalFiles } from './approvals.js'
import { readFishIndex, resolveFishDataDir } from './fish-index.js'
import { createPorts } from './ports/index.js'
import { RunSupervisor } from './run.js'
import { readWatchLog, verifyAnchor } from './store.js'
import { atomicWriteJson, chainKeyFromEnv, ensureDir, newId, readJson, resolveDataDir } from './util.js'

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/

/** @param {string} code @param {string} message */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return /** @type {Error & { code: string }} */ (error)
}

export class OverwatchService {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis Host context
   * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
   * @param {string} options.version
   * @param {() => number} [options.clock]
   * @param {{ info?: (msg: string) => void, warn?: (msg: string) => void }} [options.logger]
   * @param {(origin: string) => any} [options.portsFactory] test seam
   * @param {string} [options.hmacKey] chain HMAC key; defaults to OVERWATCH_CHAIN_KEY
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.version = options.version
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    this.portsFactory = options.portsFactory ?? (origin => createPorts({
      origin,
      swarmToken: this.config.ports.swarmToken !== '' ? this.config.ports.swarmToken : this.config.http.token,
      timeoutMs: this.config.sampling.requestTimeoutMs,
    }))
    this.dataDir = resolveDataDir(options.config.storage)
    this.runsDir = path.join(this.dataDir, 'runs')
    this.anchorDir = path.join(this.dataDir, 'anchors')
    this.fishDir = resolveFishDataDir(this.config.fish)
    this.instanceId = newId('ow')
    this.hmacKey = options.hmacKey ?? chainKeyFromEnv()
    /** @type {Map<string, RunSupervisor>} */
    this.runs = new Map()
    /** @type {any} */
    this.ports = null
    /** @type {NodeJS.Timeout | null} */
    this.retentionTimer = null
    this.serviceLog = new ServiceLog({
      dir: this.dataDir,
      runId: 'overwatch',
      clock: this.clock,
      maxBytes: this.config.storage.maxBytesPerRun,
      hmacKey: this.hmacKey,
      anchorFile: path.join(this.anchorDir, 'overwatch.jsonl'),
    })
    this.openedAt = null
  }

  /** @param {string} runId */
  #anchorFile(runId) {
    return path.join(this.anchorDir, `${runId}.jsonl`)
  }

  /** @returns {string | null} */
  origin() {
    try {
      const webServer = this.ctx.get?.('webServer')
      if (webServer === undefined || webServer === null) return null
      return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
    } catch {
      return null
    }
  }

  /**
   * Upstream origin for the three ports: an explicit `ports.origin` wins, then
   * the Host web server (the same process normally serves swarm/pressure/fish).
   * @returns {string | null}
   */
  upstreamOrigin() {
    if (this.config.ports.origin !== '') return this.config.ports.origin.replace(/\/$/, '')
    return this.origin()
  }

  async open() {
    ensureDir(this.dataDir)
    ensureDir(this.runsDir)
    ensureDir(path.join(this.dataDir, 'tmp'))
    ensureDir(this.anchorDir)
    await this.serviceLog.open()
    if (this.serviceLog.repaired !== null) {
      this.serviceLog.append({
        type: 'watch/store/repaired',
        actor: 'system',
        payload: { code: this.serviceLog.repaired.code, atOffset: this.serviceLog.repaired.atOffset },
      })
    }
    const event = this.serviceLog.append({
      type: 'watch/service/started',
      actor: 'system',
      payload: { version: this.version, mode: this.config.mode, instanceId: this.instanceId },
    })
    this.openedAt = event.at
    const origin = this.upstreamOrigin()
    if (origin !== null) this.attachPorts(origin)
    this.#writeIndex()
    this.#startRetention()
  }

  /**
   * Automatic retention: purge only archived runs whose last evidence is older
   * than `storage.retentionDays`, never a run this process supervises, never one
   * held by another Host, and never one whose chain cannot be verified.
   * @returns {{ retentionDays: number, cutoff: string, purged: string[], skipped: Array<{ runId: string, reason: string }> }}
   */
  retention() {
    const days = this.config.storage.retentionDays
    const now = this.clock()
    const cutoff = now - days * 86_400_000
    /** @type {string[]} */
    const purged = []
    /** @type {Array<{ runId: string, reason: string }>} */
    const skipped = []
    let names = []
    try {
      names = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return { retentionDays: days, cutoff: new Date(cutoff).toISOString(), purged, skipped }
    }
    for (const runId of names) {
      if (!RUN_ID_PATTERN.test(runId) || this.runs.has(runId)) continue
      const dir = path.join(this.runsDir, runId)
      const logFile = path.join(dir, 'watch.jsonl')
      if (!existsSync(logFile)) {
        skipped.push({ runId, reason: 'no watch log' })
        continue
      }
      // Another Host may still be supervising this run.
      if (existsSync(path.join(dir, `watch-${runId}.lock`))) {
        skipped.push({ runId, reason: 'lock is held' })
        continue
      }
      const { events, chain } = readWatchLog(dir, runId, { hmacKey: this.hmacKey })
      if (!chain.ok) {
        skipped.push({ runId, reason: 'chain is damaged' })
        continue
      }
      let updated = events.at(-1)?.at ?? null
      if (updated === null) {
        try {
          updated = new Date(statSync(logFile).mtimeMs).toISOString()
        } catch {
          skipped.push({ runId, reason: 'mtime unavailable' })
          continue
        }
      }
      const updatedMs = Date.parse(updated)
      if (!Number.isFinite(updatedMs) || updatedMs > cutoff) continue
      try {
        this.serviceLog.append({
          type: 'watch/service/retention',
          actor: 'system',
          payload: {
            runId,
            reason: `older than storage.retentionDays (${days})`,
            retentionDays: days,
            cutoff: new Date(cutoff).toISOString(),
            lastEventAt: updated,
            chain,
            purgedAt: new Date(now).toISOString(),
          },
        })
        rmSync(dir, { recursive: true, force: true })
        purged.push(runId)
      } catch (error) {
        skipped.push({ runId, reason: messageOf(error) })
      }
    }
    return { retentionDays: days, cutoff: new Date(cutoff).toISOString(), purged, skipped }
  }

  #startRetention() {
    if (this.retentionTimer !== null) return
    try {
      const result = this.retention()
      if (result.purged.length > 0) this.logger?.info?.(`[overwatch] retention purged ${result.purged.join(', ')}`)
    } catch (error) {
      this.logger?.warn?.(`[overwatch] retention scan failed: ${messageOf(error)}`)
    }
    const everyMs = 6 * 3_600_000
    const timer = setInterval(() => {
      try {
        const result = this.retention()
        if (result.purged.length > 0) this.logger?.info?.(`[overwatch] retention purged ${result.purged.join(', ')}`)
      } catch (error) {
        this.logger?.warn?.(`[overwatch] retention scan failed: ${messageOf(error)}`)
      }
    }, everyMs)
    timer.unref?.()
    this.retentionTimer = timer
  }

  /** @param {string} origin */
  attachPorts(origin) {
    this.ports = this.portsFactory(this.config.ports.origin !== '' ? this.config.ports.origin.replace(/\/$/, '') : origin)
    return this.ports
  }

  capabilities() {
    return {
      store: true,
      http: this.origin() !== null && this.config.http.enabled,
      write: this.config.http.token !== '',
      guard: true,
      supervisor: true,
      watchOfficer: 'm2',
      ports: {
        swarm: this.ports !== null,
        pressure: this.ports !== null,
        fish: this.ports !== null,
      },
    }
  }

  /**
   * Start supervising a live swarm run.
   * @param {{ runId: string, mode?: 'observe'|'guard'|'supervised', parentAgent?: any, agentId?: string }} input
   */
  async arm(input) {
    const runId = String(input?.runId ?? '')
    if (!RUN_ID_PATTERN.test(runId)) throw fail('INVALID_RUN_ID', 'runId must match [A-Za-z0-9_-]{1,200}')
    if (this.runs.has(runId)) throw fail('ALREADY_ARMED', `run ${runId} is already supervised by this process`)
    let origin = this.upstreamOrigin()
    if (origin === null) {
      throw fail('WEB_UNAVAILABLE', 'no upstream origin: the Host web server is not ready and ports.origin is empty')
    }
    if (this.ports === null) this.attachPorts(origin)
    const supervisor = new RunSupervisor({
      runId,
      config: this.config,
      ports: this.ports,
      ctx: this.ctx,
      dir: path.join(this.runsDir, runId),
      clock: this.clock,
      logger: this.logger,
      hmacKey: this.hmacKey,
      anchorFile: this.#anchorFile(runId),
    })
    try {
      await supervisor.open()
    } catch (error) {
      supervisor.close()
      throw error
    }
    // Publish before arm: the watch child is created inside `arm()`, and its
    // serial agent/created listener must find this supervisor in the registry to
    // apply the tool restriction.
    this.runs.set(runId, supervisor)
    try {
      const result = await supervisor.arm({ mode: input.mode, parentAgent: input.parentAgent })
      this.#writeIndex()
      this.logger?.info?.(`[overwatch] armed ${runId} mode=${result.mode}`)
      return result
    } catch (error) {
      this.runs.delete(runId)
      supervisor.close()
      throw error
    }
  }

  /**
   * Serial `agent/created` fan-out. Must not throw: a listener error would fail
   * child creation. The watch officer restricts the child synchronously.
   * @param {any} agent
   */
  handleAgentCreated(agent) {
    for (const supervisor of this.runs.values()) {
      try {
        supervisor.handleAgentCreated(agent)
      } catch (error) {
        this.logger?.warn?.(`[overwatch] agent/created handler failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * @param {any} session
   * @param {any} event
   */
  recordSessionEvent(session, event) {
    const id = String(session?.id ?? '')
    if (id === '') return
    for (const supervisor of this.runs.values()) {
      try {
        supervisor.recordUsage(id, event)
      } catch {
        // Usage accounting must never break the child's turn.
      }
    }
  }

  /** @param {string} runId @param {string} [reason] */
  async disarm(runId, reason = 'disarmed by operator') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', `run ${runId} is not supervised by this process`)
    const result = await supervisor.disarm(reason)
    this.runs.delete(runId)
    this.#writeIndex()
    return result
  }

  /** @param {string} runId */
  #validateRunId(runId) {
    if (!RUN_ID_PATTERN.test(runId)) throw fail('INVALID_RUN_ID', 'runId must match [A-Za-z0-9_-]{1,200}')
    return path.join(this.runsDir, runId)
  }

  /** @param {string} runId */
  #dir(runId) {
    return this.#validateRunId(runId)
  }

  /** @returns {any[]} */
  listRuns() {
    /** @type {Map<string, any>} */
    const summaries = new Map()
    for (const [runId, supervisor] of this.runs) {
      const view = supervisor.snapshot()
      summaries.set(runId, {
        runId,
        armed: true,
        state: view.state,
        mode: view.mode,
        goal: view.goal,
        status: view.status,
        budget: view.budget,
        openCases: view.cases.open,
        updatedAt: view.snapshot?.asOf ?? view.armedAt,
      })
    }
    let names = []
    try {
      names = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      names = []
    }
    for (const runId of names) {
      if (summaries.has(runId)) continue
      const archive = readArchive(this.runsDir, runId, this.clock, this.hmacKey)
      summaries.set(runId, {
        runId,
        armed: false,
        state: archive.state,
        mode: archive.mode,
        goal: archive.goal,
        status: archive.status,
        budget: archive.budget,
        openCases: archive.openCases,
        updatedAt: archive.updatedAt,
      })
    }
    return [...summaries.values()].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  /** @param {string} runId */
  getRun(runId) {
    const dir = this.#dir(runId)
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.snapshot()
    if (!existsSync(dir)) return null
    return readArchiveView(dir, runId, this.clock, this.hmacKey)
  }

  /** @param {string} runId @param {{ state?: string, limit?: number }} [query] */
  cases(runId, query = {}) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.cases(query)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    const records = readCaseFiles(dir)
    return filterCases(records, query)
  }

  /** @param {string} runId @param {string} caseId */
  caseDetail(runId, caseId) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.caseDetail(caseId)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    const record = readCaseFiles(dir).find(entry => entry.id === caseId) ?? null
    if (record === null) return null
    return { case: record, timeline: archiveTimeline(dir, runId, { limit: 50 }, this.hmacKey).events }
  }

  /** @param {string} runId @param {{ since?: number, limit?: number }} [query] */
  timeline(runId, query = {}) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.timeline(query)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    return archiveTimeline(dir, runId, query, this.hmacKey)
  }

  /** @param {string} runId @param {string} caseId @param {string} [note] */
  acknowledge(runId, caseId, note = '') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to acknowledge its cases')
    return supervisor.acknowledge(caseId, note)
  }

  /**
   * @param {string} runId
   * @param {string} caseId
   * @param {string} [reason]
   * @param {string} [note]
   */
  closeCase(runId, caseId, reason = 'resolved', note = '') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to close its cases')
    return supervisor.closeCase(caseId, reason, note)
  }

  /** @param {string} runId @param {string} [reason] */
  async resume(runId, reason = 'resumed by operator') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm before resuming')
    return supervisor.resume(reason)
  }

  /**
   * Approval queue for a run. Live runs are authoritative; archived runs are a
   * read-only view of the persisted approval files.
   * @param {string} runId
   * @param {{ state?: string, limit?: number }} [query]
   */
  approvals(runId, query = {}) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.approvals(query)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    return readApprovalFiles(path.join(dir, 'approvals'), runId, query)
  }

  /** @param {string} runId @param {string} approvalId */
  approvalDetail(runId, approvalId) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.approvalDetail(approvalId)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    return readApprovalFiles(path.join(dir, 'approvals'), runId, { limit: 200 }).find(record => record.id === approvalId) ?? null
  }

  /**
   * Mint a short-lived one-time token for one pending approval.
   * @param {string} runId
   * @param {string} approvalId
   */
  challengeApproval(runId, approvalId) {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to approve its queue')
    return supervisor.challengeApproval(approvalId)
  }

  /**
   * @param {string} runId
   * @param {string} approvalId
   * @param {string} token
   * @param {string} [note]
   */
  async approveApproval(runId, approvalId, token, note = '') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to approve its queue')
    return supervisor.approveApproval(approvalId, token, note)
  }

  /**
   * @param {string} runId
   * @param {string} approvalId
   * @param {string} [reason]
   */
  rejectApproval(runId, approvalId, reason = '') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to decide its queue')
    return supervisor.rejectApproval(approvalId, reason)
  }

  /**
   * Explicit human purge of an archived run. The service log gets a tombstone
   * before any file is removed; an armed run can never be purged.
   * @param {string} runId
   * @param {{ confirm?: unknown, reason?: unknown }} input
   */
  purge(runId, input = {}) {
    if (!RUN_ID_PATTERN.test(runId)) throw fail('INVALID_RUN_ID', 'runId must match [A-Za-z0-9_-]{1,200}')
    if (this.runs.has(runId)) throw fail('RUN_ARMED', 'disarm the run before purging its evidence')
    const dir = path.join(this.runsDir, runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    const expected = `PURGE ${runId}`
    if (input.confirm !== expected) throw fail('CONFIRM_REQUIRED', `send {"confirm":"${expected}"} to purge`)
    const { chain } = readWatchLog(dir, runId, { hmacKey: this.hmacKey })
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 300) : 'human purge'
    this.serviceLog.append({
      type: 'watch/service/purge',
      actor: 'human',
      payload: { runId, reason, chain, purgedAt: new Date(this.clock()).toISOString() },
    })
    rmSync(dir, { recursive: true, force: true })
    return { runId, purged: true, chain }
  }

  /**
   * Record a browser-performed fishkeeper restore. The browser owns the
   * confirmToken; overwatch only records the intent/result for evidence.
   * @param {string} runId
   * @param {any} input
   */
  recordRestore(runId, input) {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; restore evidence needs a live watch log')
    return supervisor.recordRestore(input)
  }

  /**
   * Read-only host index of fishkeeper checkpoints and audit tails.
   * @param {string} [sourceId]
   */
  fishIndex(sourceId) {
    return readFishIndex({ dataDir: this.fishDir, sourceId })
  }

  /**
   * Doctor: configuration-independent checks with pass/warn/fail. Never writes
   * into fishkeeper or the swarm; only probes the overwatch data directory.
   */
  async doctor() {
    /** @type {Array<{ id: string, status: 'pass'|'warn'|'fail', detail: any }>} */
    const checks = []
    const add = (id, status, detail) => checks.push({ id, status, detail })
    try {
      ensureDir(path.join(this.dataDir, 'tmp'))
      const probe = path.join(this.dataDir, 'tmp', `doctor-${process.pid}-${Date.now()}.tmp`)
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      add('data-dir', 'pass', { path: this.dataDir, writable: true })
    } catch (error) {
      add('data-dir', 'fail', { path: this.dataDir, error: messageOf(error) })
    }
    const log = this.serviceLog.verify()
    add('service-log', log.ok ? 'pass' : 'fail', log)
    add('write-token', this.config.http.token === '' ? 'warn' : 'pass', { configured: this.config.http.token !== '' })
    if (this.ports === null) {
      add('upstreams', 'fail', { error: 'ports are not attached; no Host web server or ports.origin' })
    } else {
      const [swarm, pressure, fish] = await Promise.all([
        this.ports.swarm.health(),
        this.ports.pressure.health(),
        this.ports.fish.overview(),
      ])
      add('swarm', swarm.ok === true ? 'pass' : 'fail', { status: swarm.status, error: swarm.error })
      add('pressure', pressure.ok === true ? 'pass' : 'warn', { status: pressure.status, error: pressure.error })
      add('fishkeeper-write', fish.ok === true ? 'pass' : 'warn', {
        status: fish.status,
        error: fish.error,
        note: fish.ok === true ? null : 'fishkeeper routes are browser-authenticated; automatic restore stays P1',
      })
    }
    const fishIndex = readFishIndex({ dataDir: this.fishDir, maxCheckpoints: 20, maxAudit: 5 })
    add('fish-index', fishIndex.available ? (fishIndex.errors.length === 0 ? 'pass' : 'warn') : 'warn', {
      path: this.fishDir,
      available: fishIndex.available,
      sources: fishIndex.sources.length,
      checkpoints: fishIndex.checkpoints,
      errors: fishIndex.errors.slice(0, 5),
    })
    for (const [runId, supervisor] of this.runs) {
      const health = supervisor.health()
      add(`run:${runId}`, health.log.ok ? (health.lock.held ? 'pass' : 'warn') : 'fail', {
        state: health.state,
        mode: health.mode,
        lock: health.lock,
        log: { ok: health.log.ok, count: health.log.count, error: health.log.error },
        watch: health.watch?.state ?? 'disabled',
      })
    }
    let anchorRuns = []
    try {
      anchorRuns = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      anchorRuns = []
    }
    for (const runId of anchorRuns) {
      if (!RUN_ID_PATTERN.test(runId)) continue
      const supervisor = this.runs.get(runId)
      const events = supervisor !== undefined
        ? supervisor.store.read()
        : readWatchLog(path.join(this.runsDir, runId), runId, { hmacKey: this.hmacKey }).events
      const anchor = verifyAnchor(this.#anchorFile(runId), events, runId)
      add(`anchor:${runId}`, anchor.ok ? 'pass' : 'fail', { anchors: anchor.count, last: anchor.last, error: anchor.error })
    }
    try {
      const stats = statfsSync(this.dataDir)
      const freeBytes = stats.bavail * stats.bsize
      add('disk-free', freeBytes > 200 * 1024 * 1024 ? 'pass' : 'warn', { freeBytes })
    } catch (error) {
      add('disk-free', 'warn', { error: messageOf(error) })
    }
    const ok = checks.every(check => check.status !== 'fail')
    return { ok, version: this.version, dataDir: this.dataDir, checks, asOf: new Date(this.clock()).toISOString() }
  }

  /** @param {string} runId */
  report(runId) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.report()
    const view = this.getRun(runId)
    if (view === null) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    return [
      `# Overwatch report · ${runId}`,
      '',
      `- state: ${view.state} (${view.mode})`,
      `- swarm status: ${view.status}`,
      `- budget: ${view.budget.spent}/${view.budget.limit}`,
      `- cases: ${view.cases.open} open`,
      '- source: archive (the run is not supervised by this process)',
    ].join('\n')
  }

  health() {
    const verify = this.serviceLog.verify()
    const runs = []
    for (const [runId, supervisor] of this.runs) {
      const health = supervisor.health()
      runs.push({ runId, state: health.state, armed: true, freshness: health.freshness, log: health.log, watch: health.watch })
    }
    let names = []
    try {
      names = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      names = []
    }
    for (const runId of names) {
      if (this.runs.has(runId)) continue
      const archive = readArchive(this.runsDir, runId, this.clock, this.hmacKey)
      runs.push({ runId, state: archive.state, armed: false, log: archive.chain })
    }
    return {
      ok: true,
      version: this.version,
      mode: this.config.mode,
      dataDir: this.dataDir,
      instanceId: this.instanceId,
      openedAt: this.openedAt,
      service: { watch: { ok: verify.ok, events: verify.count, lastHash: verify.lastHash, error: verify.error } },
      http: { enabled: this.config.http.enabled, write: this.config.http.token !== '' },
      capabilities: this.capabilities(),
      fish: (() => {
        const index = readFishIndex({ dataDir: this.fishDir, maxCheckpoints: 10, maxAudit: 1 })
        return { available: index.available, sources: index.sources.length, checkpoints: index.checkpoints, errors: index.errors.length }
      })(),
      runs,
    }
  }

  /** Read-only event tail for the service's own log. @param {{ since?: number, limit?: number }} [query] */
  watchEvents(query = {}) {
    return this.serviceLog.read({ since: query.since, limit: Math.min(query.limit ?? 200, 1_000) })
  }

  #writeIndex() {
    try {
      atomicWriteJson(path.join(this.dataDir, 'index.json'), {
        schemaVersion: 1,
        instanceId: this.instanceId,
        updatedAt: new Date(this.clock()).toISOString(),
        runs: [...this.runs.entries()].map(([runId, supervisor]) => ({
          runId,
          mode: supervisor.mode,
          armedAt: supervisor.armedAt,
        })),
      })
    } catch (error) {
      this.logger?.warn?.(`[overwatch] could not write index: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  close() {
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }
    for (const [runId, supervisor] of this.runs) {
      try {
        void supervisor.disarm('plugin unloaded').catch(error => {
          this.logger?.warn?.(`[overwatch] could not disarm ${runId} on unload: ${String(error)}`)
        })
      } catch (error) {
        this.logger?.warn?.(`[overwatch] could not disarm ${runId} on unload: ${String(error)}`)
      }
    }
    this.runs.clear()
    try {
      if (this.serviceLog.opened) {
        this.serviceLog.append({ type: 'watch/service/stopped', actor: 'system', payload: { instanceId: this.instanceId } })
      }
    } catch {
      // best effort
    }
    this.serviceLog.close()
  }
}

/**
 * The service's own life log. It reuses the same hash-chain store so `doctor`
 * can verify that the plugin itself did not lose events.
 */
class ServiceLog {
  /** @param {{ dir: string, runId: string, clock: () => number, maxBytes: number, hmacKey?: string, anchorFile?: string }} options */
  constructor(options) {
    this.options = options
    // Lazy import avoids a circular-looking dependency at module load.
    this.store = null
  }

  async open() {
    const { WatchStore } = await import('./store.js')
    this.store = new WatchStore({
      dir: this.options.dir,
      runId: this.options.runId,
      clock: this.options.clock,
      maxBytes: this.options.maxBytes,
      hmacKey: this.options.hmacKey,
      anchorFile: this.options.anchorFile,
    })
    await this.store.open()
    return this
  }

  get opened() {
    return this.store?.opened === true
  }

  get repaired() {
    return this.store?.repaired ?? null
  }

  /** @param {any} input */
  append(input) {
    this.assertOpen()
    return this.store.append(input)
  }

  /** @param {{ since?: number, limit?: number }} [query] */
  read(query) {
    this.assertOpen()
    return this.store.read(query)
  }

  verify() {
    if (this.store === null) return { ok: false, count: 0, lastHash: null, error: 'service log is not open' }
    return this.store.verify()
  }

  close() {
    try {
      this.store?.close()
    } catch {
      // best effort
    }
  }

  assertOpen() {
    if (this.store?.opened !== true) throw fail('SERVICE_LOG_CLOSED', 'service log is not open')
  }
}

/**
 * @param {string} runsDir
 * @param {string} runId
 * @param {() => number} clock
 */
function readArchive(runsDir, runId, clock, hmacKey = '') {
  const dir = path.join(runsDir, runId)
  const { events, chain } = readWatchLog(dir, runId, { hmacKey })
  const snapshot = readJsonSafe(path.join(dir, 'snapshots', 'last.json'))
  const cases = readCaseFiles(dir)
  const armed = events.find(event => event.type === 'watch/armed') ?? null
  const disarmed = [...events].reverse().find(event => event.type === 'watch/disarmed') ?? null
  const failed = events.some(event => event.type === 'watch/error')
  const openCases = cases.filter(record => record.state !== 'closed').length
  const budget = snapshot?.snapshot?.budget ?? snapshot?.budget ?? { limit: 0, spent: 0, ratio: 0 }
  return {
    runId,
    state: snapshot?.state ?? (disarmed !== null ? 'disarmed' : failed ? 'failed' : 'unknown'),
    mode: snapshot?.mode ?? armed?.payload?.mode ?? 'guard',
    goal: snapshot?.snapshot?.goal ?? null,
    status: snapshot?.snapshot?.status ?? 'unknown',
    budget,
    openCases,
    cases,
    armed,
    disarmed,
    snapshot,
    events,
    chain,
    updatedAt: snapshot?.asOf ?? disarmed?.at ?? events.at(-1)?.at ?? new Date(clock()).toISOString(),
  }
}

/**
 * @param {string} dir
 * @param {string} runId
 * @param {() => number} clock
 */
function readArchiveView(dir, runId, clock, hmacKey = '') {
  const archive = readArchive(path.dirname(dir), runId, clock, hmacKey)
  const snapshot = archive.snapshot?.snapshot ?? {
    schemaVersion: 1,
    runId,
    asOf: archive.updatedAt,
    status: archive.status,
    budget: archive.budget,
    members: [],
    tasks: {},
    reviews: {},
    merge: {},
    lastEventAt: archive.updatedAt,
    eventGap: null,
  }
  const counts = { L1: 0, L2: 0, L3: 0, L4: 0 }
  for (const record of archive.cases) {
    if (record.state !== 'closed' && counts[record.severity] !== undefined) counts[record.severity] += 1
  }
  return {
    runId,
    armed: false,
    state: archive.state,
    mode: archive.mode,
    goal: archive.goal,
    status: archive.status,
    snapshot,
    freshness: snapshot.freshness ?? {
      swarm: { ok: false, at: null, ageMs: null, error: 'run is not supervised by this process' },
      pressure: { ok: false, at: null, ageMs: null, error: 'run is not supervised by this process' },
      fish: { ok: false, at: null, ageMs: null, error: 'run is not supervised by this process' },
    },
    budget: {
      limit: Number(archive.budget.limit ?? 0),
      spent: Number(archive.budget.spent ?? 0),
      ratio: Number(archive.budget.ratio ?? 0),
      reserve: 0,
      supervisorUsed: 0,
    },
    cases: { open: archive.openCases, bySeverity: counts, total: archive.cases.length },
    throttle: archive.snapshot?.throttle ?? null,
    interventions: archive.snapshot?.interventions ?? 0,
    lock: { held: false },
    watch: archive.snapshot?.watch ?? { enabled: false, state: 'unavailable', spent: 0, reserve: 0 },
    lastEventAt: archive.updatedAt,
    armedAt: archive.armed?.at ?? null,
    disarmedAt: archive.disarmed?.at ?? null,
    failedReason: null,
    chain: archive.chain,
  }
}

/** @param {string} dir */
function readCaseFiles(dir) {
  const casesDir = path.join(dir, 'cases')
  let names = []
  try {
    names = readdirSync(casesDir)
  } catch {
    return []
  }
  /** @type {any[]} */
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const record = JSON.parse(readFileSync(path.join(casesDir, name), 'utf8'))
      if (typeof record?.id === 'string') records.push(record)
    } catch {
      // A partial case file is derived data; the log remains authoritative.
    }
  }
  return records.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

/** @param {any[]} records @param {{ state?: string, limit?: number }} query */
function filterCases(records, query) {
  const state = query.state ?? 'all'
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  return records
    .filter(record => state === 'all' || (state === 'open' ? record.state !== 'closed' : record.state === state))
    .slice(0, limit)
}

/** @param {string} dir @param {string} runId @param {{ since?: number | string, limit?: number }} query */
function archiveTimeline(dir, runId, query, hmacKey = '') {
  const { events } = readWatchLog(dir, runId, { hmacKey })
  const since = query.since ?? 0
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  const normalized = events.map(event => ({
    seq: event.seq,
    source: 'watch',
    type: event.type,
    at: event.at,
    actor: event.actor,
    summary: summarizeWatchEvent(event),
    orderKey: `${event.at}|3|watch:${event.seq}`,
  }))
  let start = 0
  if (typeof since === 'string' && since !== '' && since !== '0') {
    const exact = normalized.findIndex(entry => entry.orderKey === since)
    if (exact >= 0) start = exact + 1
    else {
      const next = normalized.findIndex(entry => entry.orderKey > since)
      start = next < 0 ? normalized.length : next
    }
  } else {
    start = Math.max(0, Math.trunc(Number(since) || 0))
  }
  const page = normalized.slice(start, start + limit)
  return {
    events: page.map(({ orderKey: _orderKey, ...entry }) => entry),
    nextSince: page.at(-1)?.orderKey ?? (typeof since === 'string' ? since : 0),
    total: normalized.length,
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
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

/** @param {string} file */
function readJsonSafe(file) {
  try {
    return readJson(file, null)
  } catch {
    return null
  }
}
