/**
 * Read-only port for dsh-pressure. Pressure has no write API; the watch officer
 * can only observe its receipts and live readings.
 * @module dsh-overwatch/ports/pressure
 */

import { httpJson } from './http.js'

export const PRESSURE_PREFIX = '/api/dsh-pressure'

export class PressurePort {
  /**
   * @param {object} options
   * @param {string} options.origin
   * @param {number} [options.timeoutMs]
   * @param {typeof globalThis.fetch} [options.fetchImpl]
   */
  constructor(options) {
    this.origin = options.origin.replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.fetchImpl = options.fetchImpl
  }

  /** @param {string} path */
  #url(path) {
    return `${this.origin}${PRESSURE_PREFIX}${path}`
  }

  async health() {
    return httpJson(this.#url('/health'), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /** @param {string} sessionId */
  async live(sessionId) {
    return httpJson(this.#url(`/live?sessionId=${encodeURIComponent(sessionId)}`), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /** @param {string} sessionId */
  async receipt(sessionId) {
    return httpJson(this.#url(`/receipt?sessionId=${encodeURIComponent(sessionId)}`), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /** Pressure is read-only in v1; no decision targets it. */
  supports() {
    return false
  }
}
