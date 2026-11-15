/**
 * Case manager: turns signal clusters into trackable incident cases.
 *
 * A case is identified by a deterministic key (run + code + scope), so a
 * flapping threshold does not open a new case every tick. The JSON file under
 * `cases/` is a derived view; `watch.jsonl` remains the source of truth, and a
 * consistent case can always be rebuilt from it.
 * @module dsh-overwatch/cases
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, ensureDir, newId, scrubText, sha256 } from './util.js'

/** @typedef {'L0' | 'L1' | 'L2' | 'L3' | 'L4'} Severity */

export const CASE_STATES = Object.freeze(['open', 'acknowledged', 'acting', 'verifying', 'closed'])
export const CLOSE_REASONS = Object.freeze(['resolved', 'mitigated', 'escalated', 'false_positive', 'abandoned'])

const SEVERITY_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 })

/** @param {Severity} a @param {Severity} b @returns {boolean} */
export function severityAtLeast(a, b) {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0)
}

/** @param {Severity} a @param {Severity} b @returns {Severity} */
export function maxSeverity(a, b) {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * Stable scope of a signal. The evidence ref decides whether the case is about
 * the run, one member, one task or one session.
 * @param {import('./signals.js').Signal} signal
 * @returns {{ kind: string, id: string }}
 */
export function signalScope(signal) {
  const ref = signal.evidence?.ref
  if (ref !== null && typeof ref === 'object') {
    const record = /** @type {Record<string, unknown>} */ (ref)
    if (typeof record.memberId === 'string') return { kind: 'member', id: record.memberId }
    if (typeof record.taskId === 'string') return { kind: 'task', id: record.taskId }
    if (typeof record.sessionId === 'string') return { kind: 'session', id: record.sessionId }
    if (record.seq !== undefined) return { kind: 'event', id: String(record.seq) }
  }
  if (typeof ref === 'string' && ref !== '') return { kind: 'ref', id: ref }
  return { kind: 'run', id: 'run' }
}

/** @param {string} runId @param {import('./signals.js').Signal} signal @returns {string} */
export function caseKey(runId, signal) {
  const scope = signalScope(signal)
  return sha256(`${runId}\u0000${signal.code}\u0000${scope.kind}\u0000${scope.id}`)
}

/**
 * @typedef {object} CaseRecord
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} runId
 * @property {string} key
 * @property {string} state
 * @property {Severity} severity
 * @property {string} title
 * @property {string} code
 * @property {number} generation
 * @property {Array<Record<string, unknown>>} signals
 * @property {Array<Record<string, unknown>>} evidence
 * @property {Array<Record<string, unknown>>} decisions
 * @property {Array<Record<string, unknown>>} actions
 * @property {string} openedAt
 * @property {string} updatedAt
 * @property {string} lastSeenAt
 * @property {string | null} closedAt
 * @property {string | null} closeReason
 * @property {string | null} note
 * @property {string | null} reopens
 */

export class CaseManager {
  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.dir run directory (cases live in `<dir>/cases`)
   * @param {{ append: (input: any) => any }} options.store
   * @param {typeof import('./config.js').DEFAULT_CONFIG} options.config
   * @param {() => number} [options.clock]
   * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger]
   */
  constructor(options) {
    this.runId = options.runId
    this.dir = path.join(options.dir, 'cases')
    this.store = options.store
    this.config = options.config
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    /** @type {Map<string, CaseRecord>} */
    this.cases = new Map()
    /** @type {Map<string, string>} */
    this.byKey = new Map()
    /** @type {Map<string, { count: number, firstAt: number }>} */
    this.pending = new Map()
    /** @type {Map<string, number>} */
    this.notices = new Map()
    /** @type {Map<string, number>} */
    this.suppressed = new Map()
    this.loaded = false
  }

  async load() {
    ensureDir(this.dir)
    let names = []
    try {
      names = readdirSync(this.dir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8'))
        if (record?.runId !== this.runId || typeof record.id !== 'string') continue
        record.lastSeenAt = record.lastSeenAt ?? record.updatedAt ?? record.openedAt ?? null
        this.cases.set(record.id, record)
        const previous = this.byKey.get(record.key)
        if (record.state !== 'closed' && previous === undefined) this.byKey.set(record.key, record.id)
      } catch (error) {
        this.logger?.warn?.(`[overwatch] ignoring unreadable case ${name}: ${messageOf(error)}`)
      }
    }
    this.loaded = true
    return this.cases.size
  }

  /** @returns {CaseRecord[]} */
  list(query = {}) {
    const state = query.state ?? 'all'
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
    return [...this.cases.values()]
      .filter(record => state === 'all' || (state === 'open' ? record.state !== 'closed' : record.state === state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
  }

  /** @param {string} id @returns {CaseRecord | null} */
  get(id) {
    return this.cases.get(id) ?? null
  }

  openCount() {
    let count = 0
    for (const record of this.cases.values()) if (record.state !== 'closed') count += 1
    return count
  }

  /**
   * Fold one tick of signals into cases.
   * @param {{ signals: import('./signals.js').Signal[], snapshot: any, now: number }} input
   * @returns {{ opened: CaseRecord[], updated: CaseRecord[], closed: CaseRecord[], suppressed: number }}
   */
  reconcile(input) {
    const now = input.now
    const at = new Date(now).toISOString()
    const opened = []
    const updated = []
    const seen = new Set()
    let suppressed = 0

    for (const signal of input.signals) {
      const key = caseKey(this.runId, signal)
      seen.add(key)
      const existing = this.byKey.get(key)

      if (signal.severity === 'L1' || signal.severity === 'L0') {
        this.#notice(signal, at)
        continue
      }

      if (existing !== undefined) {
        const record = this.cases.get(existing)
        if (record !== undefined && record.state !== 'closed') {
          record.lastSeenAt = at
          if (this.#merge(record, signal, at)) updated.push(record)
          continue
        }
      }

      const lastClosed = this.#lastClosed(key)
      if (lastClosed !== null) {
        const cooled = now - Date.parse(lastClosed.closedAt ?? '') < this.config.policy.cooldownMs
        if (cooled && !severityAtLeast(signal.severity, this.#nextSeverity(lastClosed.severity))) {
          suppressed += 1
          continue
        }
      }

      if (signal.severity === 'L2' && this.config.policy.twoSignalRule) {
        const pending = this.pending.get(key) ?? { count: 0, firstAt: now }
        pending.count += 1
        this.pending.set(key, pending)
        if (pending.count < 2) continue
      }

      if (this.openCount() >= this.config.thresholds.maxOpenCases) {
        suppressed += 1
        this.#persistSuppressed(key, at)
        continue
      }

      const record = this.#create(signal, at, lastClosed)
      opened.push(record)
    }

    // A pending L2 that stops being reported must restart its two-tick count.
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key)

    // Resolve soft cases whose signal has been absent for the configured
    // window. Never do this while the swarm source is unavailable/stale: an
    // outage is not evidence that the condition recovered, and never while an
    // action is still being verified.
    const closed = []
    const resolveMs = Number(this.config.policy.resolveMs ?? 60_000)
    const swarmFresh = input.snapshot?.freshness?.swarm
    const canResolve = swarmFresh === undefined || swarmFresh === null
      || (swarmFresh.ok !== false && swarmFresh.stale !== true)
    if (canResolve && resolveMs >= 0) {
      for (const record of this.cases.values()) {
        if (record.state === 'closed' || record.state === 'acting' || record.state === 'verifying') continue
        if (record.severity === 'L4' || seen.has(record.key)) continue
        const lastSeen = Date.parse(record.lastSeenAt ?? record.updatedAt ?? record.openedAt ?? '')
        if (!Number.isFinite(lastSeen) || now - lastSeen < resolveMs) continue
        const result = this.close(record.id, 'resolved', `signal absent for ${Math.round((now - lastSeen) / 1000)}s`)
        if (result !== null) closed.push(result)
      }
    }
    return { opened, updated, closed, suppressed }
  }

  /**
   * Open an urgent case without the two-tick or cooldown suppression used for
   * soft signals. Hard limits must still be recorded even when the incident
   * budget is full or the same key just closed.
   * @param {import('./signals.js').Signal} signal
   * @param {number} [now]
   * @returns {CaseRecord | null}
   */
  ensure(signal, now = this.clock()) {
    if (signal.severity === 'L0' || signal.severity === 'L1') return null
    const key = caseKey(this.runId, signal)
    const existingId = this.byKey.get(key)
    if (existingId !== undefined) {
      const existing = this.cases.get(existingId)
      if (existing !== undefined && existing.state !== 'closed') return existing
    }
    const at = new Date(now).toISOString()
    return this.#create(signal, at, this.#lastClosed(key))
  }

  /**
   * @param {import('./signals.js').Signal} signal
   * @returns {CaseRecord | null}
   */
  findOpenBySignal(signal) {
    const id = this.byKey.get(caseKey(this.runId, signal))
    if (id === undefined) return null
    const record = this.cases.get(id)
    return record !== undefined && record.state !== 'closed' ? record : null
  }

  /**
   * @param {CaseRecord} record
   * @param {import('./signals.js').Signal} signal
   * @param {string} at
   * @returns {boolean} whether the case changed
   */
  #merge(record, signal, at) {
    const evidenceId = String(signal.evidence?.id ?? '')
    const known = record.signals.some(entry => entry.evidenceId === evidenceId)
    const severity = maxSeverity(record.severity, signal.severity)
    const escalated = severity !== record.severity
    if (known && !escalated) return false
    if (!known) {
      record.signals.push(signalRow(signal))
      if (!record.evidence.some(entry => entry.id === signal.evidence.id)) record.evidence.push({ ...signal.evidence })
    }
    record.severity = severity
    record.updatedAt = at
    if (escalated) record.state = record.state === 'verifying' ? 'verifying' : 'open'
    this.#write(record)
    this.store.append({
      type: 'watch/case/updated',
      actor: 'guard',
      causationRef: signal.evidence?.ref ?? null,
      payload: {
        caseId: record.id,
        code: signal.code,
        addedSignal: known ? null : signalRow(signal),
        severity: record.severity,
        escalated,
      },
    })
    return true
  }

  /**
   * @param {import('./signals.js').Signal} signal
   * @param {string} at
   * @param {CaseRecord | null} previous
   * @returns {CaseRecord}
   */
  #create(signal, at, previous) {
    const scope = signalScope(signal)
    const record = /** @type {CaseRecord} */ ({
      schemaVersion: 1,
      id: newId('case'),
      runId: this.runId,
      key: caseKey(this.runId, signal),
      state: 'open',
      severity: signal.severity,
      title: signal.summary,
      code: signal.code,
      generation: previous === null ? 1 : (previous.generation ?? 1) + 1,
      signals: [signalRow(signal)],
      evidence: [{ ...signal.evidence }],
      decisions: [],
      actions: [],
      openedAt: at,
      updatedAt: at,
      lastSeenAt: at,
      closedAt: null,
      closeReason: null,
      note: null,
      reopens: previous?.id ?? null,
    })
    this.cases.set(record.id, record)
    this.byKey.set(record.key, record.id)
    this.pending.delete(record.key)
    this.#write(record)
    this.store.append({
      type: 'watch/case/opened',
      actor: 'guard',
      causationRef: signal.evidence?.ref ?? null,
      payload: {
        caseId: record.id,
        severity: record.severity,
        code: record.code,
        title: record.title,
        scope,
        evidenceIds: record.evidence.map(entry => entry.id),
        reopens: record.reopens,
      },
    })
    this.logger?.info?.(`[overwatch] case ${record.id} opened: ${record.code} ${record.severity}`)
    return record
  }

  /** @param {import('./signals.js').Signal} signal @param {string} at */
  #notice(signal, at) {
    const bucket = Math.floor(this.clock() / 3_600_000)
    const key = `${signal.code}:${bucket}`
    if (this.notices.has(key)) return
    this.notices.set(key, this.clock())
    this.store.append({
      type: 'watch/signal',
      actor: 'guard',
      causationRef: signal.evidence?.ref ?? null,
      payload: { code: signal.code, severity: signal.severity, summary: signal.summary, value: signal.evidence?.observed ?? null },
    })
  }

  /** @param {string} key @param {string} at */
  #persistSuppressed(key, at) {
    const last = this.suppressed.get(key) ?? 0
    if (this.clock() - last < 60_000) return
    this.suppressed.set(key, this.clock())
    this.store.append({
      type: 'watch/case/suppressed',
      actor: 'guard',
      payload: { key: key.slice(0, 16), reason: 'max_open_cases', at },
    })
  }

  /** @param {string} key @returns {CaseRecord | null} */
  #lastClosed(key) {
    let newest = null
    for (const record of this.cases.values()) {
      if (record.key !== key || record.state !== 'closed') continue
      if (newest === null || (record.closedAt ?? '') > (newest.closedAt ?? '')) newest = record
    }
    return newest
  }

  /** @param {Severity} severity @returns {Severity} */
  #nextSeverity(severity) {
    const rank = (SEVERITY_RANK[severity] ?? 0) + 1
    return /** @type {Severity} */ (Object.keys(SEVERITY_RANK).find(key => SEVERITY_RANK[key] === rank) ?? 'L4')
  }

  /** @param {string} id @param {'open' | 'acknowledged' | 'acting' | 'verifying'} state */
  setState(id, state) {
    const record = this.cases.get(id)
    if (record === undefined || record.state === 'closed') return null
    record.state = state
    record.updatedAt = new Date(this.clock()).toISOString()
    this.#write(record)
    return record
  }

  /** @param {string} id @param {{ id: string, kind: string, state?: string, minutes?: number }} action */
  recordAction(id, action) {
    const record = this.cases.get(id)
    if (record === undefined || record.state === 'closed') return null
    const at = new Date(this.clock()).toISOString()
    record.actions.push({ ...action, state: action.state ?? 'intended', at })
    record.state = 'acting'
    record.updatedAt = at
    this.#write(record)
    return record
  }

  /** @param {string} id @param {string} actionId @param {string} state @param {Record<string, unknown>} [detail] */
  recordActionState(id, actionId, state, detail = {}) {
    const record = this.cases.get(id)
    if (record === undefined || record.state === 'closed') return null
    const action = record?.actions.find(entry => entry.id === actionId)
    if (record === undefined || action === undefined) return null
    action.state = state
    action.result = detail
    record.state = state === 'verified' ? 'verifying' : record.state
    record.updatedAt = new Date(this.clock()).toISOString()
    this.#write(record)
    return record
  }

  /** @param {string} id @param {Record<string, unknown>} decision */
  recordDecision(id, decision) {
    const record = this.cases.get(id)
    if (record === undefined || record.state === 'closed') return null
    record.decisions.push(decision)
    record.updatedAt = new Date(this.clock()).toISOString()
    this.#write(record)
    return record
  }

  /**
   * Invalidate a wake that is still in flight. The executor compares the
   * decision's generation with the case record, so a human takeover cannot be
   * overwritten by a late model decision.
   * @param {string} id
   * @returns {CaseRecord | null}
   */
  bumpGeneration(id) {
    const record = this.cases.get(id)
    if (record === undefined || record.state === 'closed') return null
    record.generation = (Number.isSafeInteger(record.generation) ? record.generation : 1) + 1
    record.updatedAt = new Date(this.clock()).toISOString()
    this.#write(record)
    this.store.append({
      type: 'watch/case/updated',
      actor: 'human',
      causationRef: { kind: 'case', caseId: id },
      payload: { caseId: id, generation: record.generation, reason: 'human takeover invalidated an in-flight decision' },
    })
    return record
  }

  /**
   * @param {string} id
   * @param {string} reason
   * @param {string} [note]
   */
  close(id, reason, note = '') {
    if (!CLOSE_REASONS.includes(reason)) throw new TypeError(`unknown close reason ${reason}`)
    const record = this.cases.get(id)
    if (record === undefined) return null
    if (record.state === 'closed') return record
    const at = new Date(this.clock()).toISOString()
    record.state = 'closed'
    record.closedAt = at
    record.updatedAt = at
    record.closeReason = reason
    record.note = note.slice(0, 500)
    if (this.byKey.get(record.key) === id) this.byKey.delete(record.key)
    this.#write(record)
    this.store.append({
      type: 'watch/case/closed',
      actor: 'guard',
      causationRef: { kind: 'case', caseId: id },
      payload: { caseId: id, reason, note: record.note, actions: record.actions.length },
    })
    return record
  }

  /** @param {string} reason @param {string} [note] */
  closeAll(reason, note = '') {
    /** @type {CaseRecord[]} */
    const closed = []
    for (const record of this.cases.values()) {
      if (record.state === 'closed') continue
      const result = this.close(record.id, reason, note)
      if (result !== null) closed.push(result)
    }
    return closed
  }

  /** @param {CaseRecord} record */
  #write(record) {
    ensureDir(this.dir)
    // The materialized view is read by the API and the panel; scrub it with the
    // same rules as the hash-chained log instead of persisting raw prose.
    record.title = scrubText(String(record.title ?? ''))
    if (typeof record.note === 'string') record.note = scrubText(record.note)
    for (const decision of record.decisions) {
      if (typeof decision.reason === 'string') decision.reason = scrubText(decision.reason)
      if (typeof decision.note === 'string') decision.note = scrubText(decision.note)
    }
    for (const action of record.actions) {
      if (typeof action.detail === 'string') action.detail = scrubText(action.detail)
    }
    atomicWriteJson(path.join(this.dir, `${record.id}.json`), record)
  }
}

/** @param {import('./signals.js').Signal} signal */
function signalRow(signal) {
  const observed = signal.evidence?.observed
  return {
    code: signal.code,
    severity: signal.severity,
    summary: signal.summary,
    value: observed !== null && typeof observed === 'object' && 'ratio' in observed ? observed.ratio : null,
    observed,
    evidenceId: String(signal.evidence?.id ?? ''),
    ref: signal.evidence?.ref ?? null,
    at: signal.evidence?.at ?? null,
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
