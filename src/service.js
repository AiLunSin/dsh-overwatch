/**
 * Host-side Overwatch service.
 *
 * Owns the data directory, the service-level life log, and the registry of
 * supervised runs. One process can supervise several runs; each run has its own
 * `RunSupervisor`, its own lock and its own hash chain.
 * @module dsh-overwatch/service
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createPorts } from './ports/index.js'
import { RunSupervisor } from './run.js'
import { readWatchLog } from './store.js'
import { atomicWriteJson, ensureDir, newId, readJson, resolveDataDir } from './util.js'

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
    this.instanceId = newId('ow')
    /** @type {Map<string, RunSupervisor>} */
    this.runs = new Map()
    /** @type {any} */
    this.ports = null
    this.serviceLog = new ServiceLog({ dir: this.dataDir, runId: 'overwatch', clock: this.clock, maxBytes: this.config.storage.maxBytesPerRun })
    this.openedAt = null
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

  async open() {
    ensureDir(this.dataDir)
    ensureDir(this.runsDir)
    ensureDir(path.join(this.dataDir, 'tmp'))
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
    const origin = this.origin()
    if (origin !== null) this.attachPorts(origin)
    this.#writeIndex()
  }

  /** @param {string} origin */
  attachPorts(origin) {
    this.ports = this.portsFactory(origin)
    return this.ports
  }

  capabilities() {
    return {
      store: true,
      http: this.origin() !== null && this.config.http.enabled,
      write: this.config.http.token !== '',
      guard: true,
      supervisor: false,
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
   * @param {{ runId: string, mode?: 'observe'|'guard'|'supervised', agentId?: string }} input
   */
  async arm(input) {
    const runId = String(input?.runId ?? '')
    if (!RUN_ID_PATTERN.test(runId)) throw fail('INVALID_RUN_ID', 'runId must match [A-Za-z0-9_-]{1,200}')
    if (this.runs.has(runId)) throw fail('ALREADY_ARMED', `run ${runId} is already supervised by this process`)
    let origin = this.origin()
    if (origin === null && this.config.http.enabled) {
      throw fail('WEB_UNAVAILABLE', 'the Host web server is not ready; retry when /overwatch/api/health answers')
    }
    if (origin === null) origin = 'http://127.0.0.1'
    if (this.ports === null) this.attachPorts(origin)
    const supervisor = new RunSupervisor({
      runId,
      config: this.config,
      ports: this.ports,
      dir: path.join(this.runsDir, runId),
      clock: this.clock,
      logger: this.logger,
    })
    try {
      await supervisor.open()
      const result = await supervisor.arm({ mode: input.mode, agentId: input.agentId })
      this.runs.set(runId, supervisor)
      this.#writeIndex()
      this.logger?.info?.(`[overwatch] armed ${runId} mode=${result.mode}`)
      return result
    } catch (error) {
      supervisor.close()
      throw error
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
      const archive = readArchive(this.runsDir, runId, this.clock)
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
    return readArchiveView(dir, runId, this.clock)
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
    return { case: record, timeline: archiveTimeline(dir, runId, { limit: 50 }).events }
  }

  /** @param {string} runId @param {{ since?: number, limit?: number }} [query] */
  timeline(runId, query = {}) {
    const supervisor = this.runs.get(runId)
    if (supervisor !== undefined) return supervisor.timeline(query)
    const dir = this.#dir(runId)
    if (!existsSync(dir)) throw fail('RUN_NOT_FOUND', `run ${runId} not found`)
    return archiveTimeline(dir, runId, query)
  }

  /** @param {string} runId @param {string} caseId @param {string} [note] */
  acknowledge(runId, caseId, note = '') {
    const supervisor = this.runs.get(runId)
    if (supervisor === undefined) throw fail('RUN_NOT_ARMED', 'the run is not supervised; re-arm to acknowledge its cases')
    return supervisor.acknowledge(caseId, note)
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
      runs.push({ runId, state: health.state, armed: true, freshness: health.freshness, log: health.log })
    }
    let names = []
    try {
      names = readdirSync(this.runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      names = []
    }
    for (const runId of names) {
      if (this.runs.has(runId)) continue
      const archive = readArchive(this.runsDir, runId, this.clock)
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
    for (const [runId, supervisor] of this.runs) {
      try {
        void supervisor.disarm('plugin unloaded')
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
  /** @param {{ dir: string, runId: string, clock: () => number, maxBytes: number }} options */
  constructor(options) {
    this.options = options
    // Lazy import avoids a circular-looking dependency at module load.
    this.store = null
  }

  async open() {
    const { WatchStore } = await import('./store.js')
    this.store = new WatchStore({ dir: this.options.dir, runId: this.options.runId, clock: this.options.clock, maxBytes: this.options.maxBytes })
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
function readArchive(runsDir, runId, clock) {
  const dir = path.join(runsDir, runId)
  const { events, chain } = readWatchLog(dir, runId)
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
function readArchiveView(dir, runId, clock) {
  const archive = readArchive(path.dirname(dir), runId, clock)
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

/** @param {string} dir @param {string} runId @param {{ since?: number, limit?: number }} query */
function archiveTimeline(dir, runId, query) {
  const { events } = readWatchLog(dir, runId)
  const since = Math.max(0, Math.trunc(query.since ?? 0))
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  const normalized = events.map(event => ({
    seq: event.seq,
    source: 'watch',
    type: event.type,
    at: event.at,
    actor: event.actor,
    summary: summarizeWatchEvent(event),
  }))
  const page = normalized.slice(since, since + limit)
  return { events: page, nextSince: since + page.length, total: normalized.length }
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
