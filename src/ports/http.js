/**
 * Minimal JSON-over-HTTP helper for the three read/write upstream ports.
 * Never throws: callers record `unavailable` and keep the run alive.
 * @module dsh-overwatch/ports/http
 */

/**
 * @param {string} url
 * @param {object} [options]
 * @param {'GET'|'POST'|'HEAD'} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {unknown} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number, data: unknown, error: string | null, ms: number }>}
 */
export async function httpJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const maxBytes = options.maxBytes ?? 2_097_152
  const startedAt = Date.now()
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, data: null, error: 'fetch is unavailable in this runtime', ms: 0 }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const headers = { accept: 'application/json', ...options.headers }
    let body
    if (options.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      body = JSON.stringify(options.body)
    }
    const response = await fetchImpl(url, { method: options.method ?? 'GET', headers, body, signal: controller.signal })
    const text = await response.text()
    const ms = Date.now() - startedAt
    if (text.length > maxBytes) {
      return { ok: false, status: response.status, data: null, error: `response exceeds ${maxBytes} bytes`, ms }
    }
    let data = null
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        return { ok: false, status: response.status, data: text.slice(0, 500), error: 'response is not JSON', ms }
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
      ms,
    }
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}
