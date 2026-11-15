/**
 * Persistent approval queue for decisions and guard plans that require a human.
 *
 * A denied-but-approvable request becomes a durable record under
 * `<run>/approvals/<id>.json` and a `watch/approval/*` audit event. A human then
 * asks for a one-time challenge token, and approving with that token consumes it
 * and executes the stored request exactly once.
 * @module dsh-overwatch/approvals
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, ensureDir, isSymlink, newId, sha256 } from './util.js'

export const APPROVAL_STATUSES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired', 'executed', 'failed',
])

export class ApprovalError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
  }
}

export class ApprovalQueue {
  /**
   * @param {object} options
   * @param {string} options.dir directory holding one JSON file per approval
   * @param {string} options.runId
   * @param {{ append: (input: { type: string, payload: unknown, actor?: string, generation?: number }) => unknown }} options.store live watch store
   * @param {() => number} [options.clock]
   * @param {number} [options.ttlMs] how long a pending approval stays approvable
   * @param {number} [options.challengeTtlMs] lifetime of a one-time token
   */
  constructor(options) {
    this.dir = options.dir
    this.runId = options.runId
    this.store = options.store
    this.clock = options.clock ?? Date.now
    this.ttlMs = options.ttlMs ?? 3_600_000
    this.challengeTtlMs = options.challengeTtlMs ?? 300_000
    /** @type {Map<string, any>} */
    this.records = new Map()
  }

  /** Load every approval file for this run; corrupt evidence fails loudly. */
  load() {
    ensureDir(this.dir)
    let names = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return this
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.dir, name)
      if (isSymlink(file)) continue
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'))
        if (record === null || typeof record !== 'object' || record.runId !== this.runId || typeof record.id !== 'string') {
          throw new Error('unexpected shape')
        }
        this.records.set(record.id, record)
      } catch (error) {
        throw new ApprovalError(`approval file ${name} is corrupt: ${error instanceof Error ? error.message : String(error)}`, 'EAPPROVALCORRUPT')
      }
    }
    this.expire()
    return this
  }

  /**
   * Enqueue a request. Repeated ticks with the same idempotency key reuse the
   * existing pending approval instead of flooding the queue.
   * @param {object} input
   * @param {'decision'|'guard_plan'} input.kind
   * @param {string} input.key idempotency key of the pending action
   * @param {string} input.caseId
   * @param {string} [input.severity]
   * @param {string} input.action
   * @param {unknown} [input.target]
   * @param {unknown} [input.params]
   * @param {string[]} [input.evidenceRefs]
   * @param {string} input.reason
   * @param {unknown} input.request the exact decision or plan to execute
   * @returns {{ approval: any, existing: boolean }}
   */
  request(input) {
    if (input.kind !== 'decision' && input.kind !== 'guard_plan') {
      throw new ApprovalError(`unknown approval kind ${String(input.kind)}`, 'EAPPROVALKIND')
    }
    this.expire()
    for (const record of this.records.values()) {
      if (record.status === 'pending' && record.key === input.key) {
        return { approval: this.publicView(record), existing: true }
      }
    }
    const now = this.clock()
    const record = {
      v: 1,
      id: newId('apv'),
      runId: this.runId,
      kind: input.kind,
      key: input.key,
      caseId: input.caseId,
      severity: input.severity ?? null,
      action: input.action,
      target: input.target ?? null,
      params: input.params ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      reason: input.reason,
      request: input.request,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      tokenHash: null,
      tokenExpiresAt: null,
      consumedAt: null,
      note: null,
      rejectionReason: null,
      outcome: null,
    }
    this.records.set(record.id, record)
    this.#write(record)
    this.#event('watch/approval/requested', {
      approvalId: record.id,
      kind: record.kind,
      caseId: record.caseId,
      severity: record.severity,
      action: record.action,
      reason: record.reason,
      expiresAt: record.expiresAt,
    }, 'system')
    return { approval: this.publicView(record), existing: false }
  }

  /**
   * Mint a fresh one-time token for a pending approval. Any previous challenge
   * for the same approval is invalidated.
   * @param {string} id
   * @returns {{ approval: any, token: string, expiresAt: string }}
   */
  challenge(id) {
    this.expire()
    const record = this.#pending(id)
    const token = randomBytes(24).toString('base64url')
    const now = this.clock()
    record.tokenHash = hashToken(record.id, token)
    record.tokenExpiresAt = new Date(now + this.challengeTtlMs).toISOString()
    record.updatedAt = new Date(now).toISOString()
    this.#write(record)
    this.#event('watch/approval/challenged', { approvalId: record.id, tokenExpiresAt: record.tokenExpiresAt })
    return { approval: this.publicView(record), token, expiresAt: record.tokenExpiresAt }
  }

  /**
   * Consume a challenge token and mark the approval approved. The caller is
   * responsible for executing the stored request and then calling `complete`.
   * @param {string} id
   * @param {string} token
   * @param {string} [note]
   * @returns {any} the internal record, including the stored request
   */
  approve(id, token, note) {
    this.expire()
    const record = this.#pending(id)
    if (typeof token !== 'string' || token === '') throw new ApprovalError('an approval token is required', 'APPROVAL_TOKEN_REQUIRED')
    if (typeof record.tokenHash !== 'string') throw new ApprovalError('request a challenge token first', 'APPROVAL_TOKEN_REQUIRED')
    const now = this.clock()
    if (typeof record.tokenExpiresAt === 'string' && Date.parse(record.tokenExpiresAt) <= now) {
      record.tokenHash = null
      record.tokenExpiresAt = null
      record.updatedAt = new Date(now).toISOString()
      this.#write(record)
      throw new ApprovalError('the approval token has expired; request a new challenge', 'APPROVAL_TOKEN_EXPIRED')
    }
    const expected = Buffer.from(record.tokenHash, 'hex')
    const actual = Buffer.from(hashToken(record.id, token), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ApprovalError('the approval token is invalid', 'APPROVAL_TOKEN_INVALID')
    }
    record.status = 'approved'
    record.tokenHash = null
    record.tokenExpiresAt = null
    record.consumedAt = new Date(now).toISOString()
    record.note = typeof note === 'string' && note.trim() !== '' ? note.trim() : null
    record.updatedAt = record.consumedAt
    this.#write(record)
    this.#event('watch/approval/approved', { approvalId: record.id, note: record.note })
    return { ...record }
  }

  /**
   * Record the result of executing an approved request.
   * @param {string} id
   * @param {'executed'|'failed'} status
   * @param {{ ok?: boolean, actionId?: string|null, code?: string|null, verified?: boolean, error?: string }} [outcome]
   * @returns {any}
   */
  complete(id, status, outcome = {}) {
    const record = this.#get(id)
    if (status !== 'executed' && status !== 'failed') throw new ApprovalError(`invalid completion status ${status}`, 'EAPPROVALSTATUS')
    const now = this.clock()
    record.status = status
    record.outcome = outcome
    record.updatedAt = new Date(now).toISOString()
    this.#write(record)
    this.#event(status === 'executed' ? 'watch/approval/executed' : 'watch/approval/failed', { approvalId: record.id, outcome })
    return this.publicView(record)
  }

  /**
   * Reject a pending approval.
   * @param {string} id
   * @param {string} reason
   * @returns {any}
   */
  reject(id, reason) {
    this.expire()
    const record = this.#pending(id)
    const now = this.clock()
    record.status = 'rejected'
    record.rejectionReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'rejected by a human'
    record.updatedAt = new Date(now).toISOString()
    this.#write(record)
    this.#event('watch/approval/rejected', { approvalId: record.id, reason: record.rejectionReason })
    return this.publicView(record)
  }

  /** Mark overdue pending approvals as expired. @returns {number} */
  expire() {
    const now = this.clock()
    let expired = 0
    for (const record of this.records.values()) {
      if (record.status !== 'pending' || typeof record.expiresAt !== 'string') continue
      if (Date.parse(record.expiresAt) > now) continue
      record.status = 'expired'
      record.updatedAt = new Date(now).toISOString()
      record.note = 'expired before a human decided'
      record.tokenHash = null
      record.tokenExpiresAt = null
      this.#write(record)
      this.#event('watch/approval/expired', { approvalId: record.id })
      expired += 1
    }
    return expired
  }

  /** Drop pending approvals when a run is disarmed; they can never execute. */
  cancelPending(reason) {
    const now = this.clock()
    let cancelled = 0
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue
      record.status = 'expired'
      record.updatedAt = new Date(now).toISOString()
      record.note = typeof reason === 'string' && reason !== '' ? reason : 'run is no longer armed'
      record.tokenHash = null
      record.tokenExpiresAt = null
      this.#write(record)
      this.#event('watch/approval/expired', { approvalId: record.id, reason: record.note })
      cancelled += 1
    }
    return cancelled
  }

  /** @param {{ state?: string, limit?: number }} [query] */
  list(query = {}) {
    this.expire()
    const state = typeof query.state === 'string' && query.state !== '' ? query.state : null
    const limit = Number.isSafeInteger(query.limit) ? Math.min(Math.max(/** @type {number} */ (query.limit), 1), 200) : 100
    return [...this.records.values()]
      .filter(record => state === null || record.status === state)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-limit)
      .map(record => this.publicView(record))
  }

  /** @param {string} id */
  get(id) {
    const record = this.records.get(id)
    return record === undefined ? null : this.publicView(record)
  }

  pendingCount() {
    return [...this.records.values()].filter(record => record.status === 'pending').length
  }

  /** Remove secrets and the executable payload from the read model. */
  /** @param {any} record */
  publicView(record) {
    return approvalView(record)
  }

  /** @param {string} id */
  #get(id) {
    const record = this.records.get(id)
    if (record === undefined) throw new ApprovalError(`approval ${id} does not exist`, 'APPROVAL_NOT_FOUND')
    return record
  }

  /** @param {string} id */
  #pending(id) {
    const record = this.#get(id)
    if (record.status !== 'pending') {
      throw new ApprovalError(`approval ${id} is ${record.status}, not pending`, 'APPROVAL_CONFLICT')
    }
    return record
  }

  /** @param {any} record */
  #write(record) {
    atomicWriteJson(this.#file(record.id), record)
  }

  /** @param {string} id */
  #file(id) {
    return path.join(this.dir, `${id}.json`)
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   * @param {string} [actor]
   */
  #event(type, payload, actor = 'human') {
    this.store.append({ type, payload, actor })
  }
}

/**
 * Read approval records for an archived run without opening a live queue.
 * @param {string} dir directory holding approval JSON files
 * @param {string} runId
 * @param {{ state?: string, limit?: number }} [query]
 * @returns {any[]}
 */
export function readApprovalFiles(dir, runId, query = {}) {
  /** @type {any[]} */
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const state = typeof query.state === 'string' && query.state !== '' ? query.state : null
  const limit = Number.isSafeInteger(query.limit) ? Math.min(Math.max(/** @type {number} */ (query.limit), 1), 200) : 100
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    if (isSymlink(file)) continue
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record === null || typeof record !== 'object' || record.runId !== runId) continue
      if (state !== null && record.status !== state) continue
      records.push(record)
    } catch {
      // A read-only view must not pretend a corrupt approval is absent; it is
      // reported through the run's chain/doctor instead of throwing here.
    }
  }
  return records
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(-limit)
    .map(approvalView)
}

/** @param {any} record */
export function approvalView(record) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    caseId: record.caseId,
    severity: record.severity ?? null,
    action: record.action,
    target: record.target ?? null,
    params: record.params ?? null,
    evidenceRefs: record.evidenceRefs ?? [],
    reason: record.reason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    tokenExpiresAt: record.tokenExpiresAt ?? null,
    consumedAt: record.consumedAt ?? null,
    note: record.note ?? null,
    rejectionReason: record.rejectionReason ?? null,
    outcome: record.outcome ?? null,
  }
}

/**
 * Hash binds the token to one approval, so a token from another approval can
 * never be replayed here even if an attacker learns it.
 * @param {string} id
 * @param {string} token
 */
function hashToken(id, token) {
  return sha256(`${id}\u0000${token}`)
}
