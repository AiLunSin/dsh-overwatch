/**
 * `/overwatch/api/*` on the Host's existing web server.
 *
 * The Host web server provides no server-wide authentication or origin policy
 * (the upstream pattern is that each route owner enforces its own), so this
 * handler does: loopback-only, same-origin for browser requests, and a write
 * token for POST. GET routes expose no secrets and no upstream payloads.
 * @module dsh-overwatch/http
 */

/** @param {import('node:http').IncomingMessage} req */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} origin expected `http://host:port`
 * @param {string} token configured write token (empty disables writes)
 * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
 */
export function checkWriteRequest(req, origin, token) {
  if (!isLoopback(req)) return { ok: false, status: 403, code: 'LOOPBACK_ONLY', message: 'overwatch API is local-only' }
  const incomingOrigin = req.headers.origin
  if (typeof incomingOrigin === 'string' && incomingOrigin !== '' && incomingOrigin !== origin) {
    return { ok: false, status: 403, code: 'CROSS_ORIGIN', message: 'cross-origin writes are not allowed' }
  }
  if (token === '') return { ok: false, status: 403, code: 'WRITE_DISABLED', message: 'write API is disabled; configure http.token' }
  const direct = req.headers['x-overwatch-token']
  const bearer = req.headers.authorization
  const supplied = typeof direct === 'string'
    ? direct
    : typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')
      ? bearer.slice(7).trim()
      : ''
  if (supplied !== token) return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'missing or invalid overwatch token' }
  return { ok: true }
}

/**
 * @param {object} options
 * @param {import('./service.js').OverwatchService} options.service
 * @param {{ http: { enabled: boolean, token: string } }} options.config
 * @param {string} options.version
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createNodeHandler(options) {
  const { service, config, version } = options
  const origin = service.origin() ?? 'http://127.0.0.1'
  return async function overwatchHandler(req, res) {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: { code: 'LOOPBACK_ONLY', message: 'overwatch API is local-only' } })
        return
      }
      const url = new URL(req.url ?? '/', origin)
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        const check = checkWriteRequest(req, origin, config.http.token)
        if (!check.ok) {
          sendJson(res, check.status, { error: { code: check.code, message: check.message } })
          return
        }
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no write route in this build' } })
        return
      }
      if (url.pathname === '/overwatch/api/health') {
        sendJson(res, 200, { ...await service.health(), version })
        return
      }
      if (url.pathname === '/overwatch/api/watch') {
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
        sendJson(res, 200, { events: service.watchEvents({ since: Number.isFinite(since) ? since : 0, limit: Number.isFinite(limit) ? limit : 200 }) })
        return
      }
      if (url.pathname === '/overwatch/api/watch/verify') {
        sendJson(res, 200, service.store.verify())
        return
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown overwatch route' } })
    } catch (error) {
      try {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } })
      } catch {
        res.destroy()
      }
    }
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
