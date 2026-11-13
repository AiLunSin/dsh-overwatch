/**
 * Read-only port for fish-keeper-console.
 *
 * Its routes live on `ctx.connection.fetch`, i.e. the browser-authenticated
 * `/api` channel. A Host `fetch()` without a browser credential is expected to
 * be rejected; `available` records that honestly instead of pretending the
 * fish tank can be written from the Host.
 * @module dsh-overwatch/ports/fish
 */

import { httpJson } from './http.js'

export const FISH_PREFIX = '/api/fishkeeper'

export class FishPort {
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
    this.available = null
  }

  /** @param {string} path */
  #url(path) {
    return `${this.origin}${FISH_PREFIX}${path}`
  }

  async overview() {
    const response = await httpJson(this.#url('/overview'), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
    this.available = response.ok
    return response
  }

  async timeline(query = '') {
    return httpJson(this.#url(`/timeline${query}`), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl })
  }

  /** Fishkeeper writes need a browser credential plus confirmToken; v1 never does this. */
  supports() {
    return false
  }
}
