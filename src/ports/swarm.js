/**
 * Read/write port for a local dsh-swarm API.
 *
 * Writes use `POST /swarm/api/runs/:id/intervene` with the configured token.
 * The v1 watch officer's `coach` and `throttle` map to `steer`, which upstream
 * records as an event but does not (yet) deliver to a member inbox — the watch
 * log and the UI must say so.
 * @module dsh-overwatch/ports/swarm
 */

import { httpJson } from './http.js'

export const SWARM_PREFIX = '/swarm/api'

export class SwarmPort {
  /**
   * @param {object} options
   * @param {string} options.origin e.g. `http://127.0.0.1:3000`
   * @param {string} [options.token]
   * @param {number} [options.timeoutMs]
   * @param {typeof globalThis.fetch} [options.fetchImpl]
   */
  constructor(options) {
    this.origin = options.origin.replace(/\/$/, '')
    this.token = options.token ?? ''
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.fetchImpl = options.fetchImpl
  }

  /** @param {string} path */
  #url(path) {
    return `${this.origin}${SWARM_PREFIX}${path}`
  }

  async health() {
    return httpJson(this.#url('/health'), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  async runs() {
    return httpJson(this.#url('/runs'), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /** @param {string} runId */
  async run(runId) {
    return httpJson(this.#url(`/runs/${encodeURIComponent(runId)}?detail=false`), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /**
   * @param {string} runId
   * @param {{ since?: number, limit?: number }} [query]
   */
  async events(runId, query = {}) {
    const params = new URLSearchParams()
    if (query.since !== undefined) params.set('since', String(query.since))
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.size > 0 ? `?${params}` : ''
    return httpJson(this.#url(`/runs/${encodeURIComponent(runId)}/events${suffix}`), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /**
   * @param {string} runId
   * @param {{ action: string, reason?: string, actor?: string, text?: string, tokens?: number }} body
   */
  async intervene(runId, body) {
    const headers = {}
    if (this.token !== '') headers['x-swarm-token'] = this.token
    return httpJson(this.#url(`/runs/${encodeURIComponent(runId)}/intervene`), {
      method: 'POST',
      headers,
      body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    })
  }

  /** @param {import('../policy.js').Decision} decision */
  supports(decision) {
    return decision.target.kind === 'swarm_run' || decision.target.kind === 'swarm_member' || decision.target.kind === 'swarm_task'
  }

  /**
   * @param {import('../policy.js').Decision} decision
   * @param {{ actionId: string }} context
   */
  async apply(decision, context) {
    const runId = typeof decision.params.runId === 'string' ? decision.params.runId : decision.target.id
    const actor = 'overwatch'
    const reason = decision.reason
    /** @type {{ action: string, reason?: string, actor?: string, text?: string, target?: unknown }} */
    let body
    if (decision.action === 'pause') body = { action: 'pause', reason, actor }
    else if (decision.action === 'resume') body = { action: 'resume', reason, actor }
    else if (decision.action === 'abort') body = { action: 'abort', reason, actor }
    else if (decision.action === 'throttle') {
      // v1 throttle is a pause with a scheduled resume (the executor/guard owns
      // the timer); upstream has no precise concurrency throttle.
      body = { action: 'pause', reason: `throttle: ${reason}`, actor }
    } else if (decision.action === 'coach') {
      body = { action: 'steer', reason, actor, text: decision.params.text !== undefined ? String(decision.params.text) : decision.reason }
      if (decision.target.kind === 'swarm_member') body.target = decision.target.id
    } else if (decision.action === 'notice' || decision.action === 'escalate') {
      return { ok: true, kind: 'record-only', actionId: context.actionId, note: `${decision.action} is recorded in the watch log only` }
    } else {
      return { ok: false, kind: 'unsupported', error: `swarm port does not support ${decision.action}` }
    }
    const response = await this.intervene(runId, body)
    return { ok: response.ok, kind: body.action, httpStatus: response.status, error: response.error, data: response.data }
  }

  /**
   * @param {import('../policy.js').Decision} decision
   * @param {{ runId?: string }} result
   */
  async verify(decision, result) {
    if (decision.action === 'notice' || decision.action === 'escalate') return { ok: true, detail: { kind: 'record-only' } }
    if (result?.ok !== true) return { ok: false, detail: { reason: 'write failed', error: result?.error ?? null } }
    const runId = typeof decision.params.runId === 'string' ? decision.params.runId : decision.target.id
    const snapshot = await this.run(runId)
    if (!snapshot.ok || snapshot.data === null || typeof snapshot.data !== 'object') {
      // A steer is accepted by the API but may not be reflected by the snapshot.
      return { ok: decision.action === 'throttle' || decision.action === 'coach', detail: { kind: 'accepted-not-observed', status: snapshot.status } }
    }
    const status = /** @type {any} */ (snapshot.data)?.state?.status ?? /** @type {any} */ (snapshot.data)?.status
    if (decision.action === 'pause') return { ok: status === 'paused', detail: { status } }
    if (decision.action === 'throttle') return { ok: status === 'paused', detail: { status, kind: 'throttle-as-pause' } }
    if (decision.action === 'resume') return { ok: status === 'running', detail: { status } }
    if (decision.action === 'abort') return { ok: status === 'aborted' || status === 'converged', detail: { status } }
    return { ok: true, detail: { status } }
  }
}
