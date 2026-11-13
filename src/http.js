/**
 * `/overwatch/api/*` on the Host's existing web server.
 *
 * The Host web server provides no server-wide authentication or origin policy
 * (the upstream pattern is that each route owner enforces its own), so this
 * handler does: loopback-only, same-origin for browser requests, and a write
 * token for POST. Read routes expose only counts, ids and short summaries.
 * @module dsh-overwatch/http
 */

const RUN_ID = /^[A-Za-z0-9_-]{1,200}$/
const MAX_BODY_BYTES = 64 * 1024

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
  const { service, config } = options
  const origin = service.origin() ?? 'http://127.0.0.1'
  return async function overwatchHandler(req, res) {
    const head = (req.method ?? 'GET').toUpperCase() === 'HEAD'
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, errorBody('LOOPBACK_ONLY', 'overwatch API is local-only'), head)
        return
      }
      const method = (req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', origin)
      const parts = url.pathname.split('/').filter(segment => segment !== '')
      if (parts[0] !== 'overwatch' || parts[1] !== 'api') {
        sendJson(res, 404, errorBody('NOT_FOUND', 'unknown overwatch route'), head)
        return
      }
      const rest = parts.slice(2)
      if (method !== 'GET' && method !== 'HEAD') {
        const check = checkWriteRequest(req, origin, config.http.token)
        if (!check.ok) {
          sendJson(res, check.status, errorBody(check.code, check.message), head)
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'use GET or POST'), head)
          return
        }
        await handleWrite({ service, rest, url, req, res })
        return
      }
      await handleRead({ service, rest, url, res, head })
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'INTERNAL'
      const status = statusFor(code)
      try {
        sendJson(res, status, errorBody(code, error instanceof Error ? error.message : String(error)), head)
      } catch {
        res.destroy()
      }
    }
  }
}

/**
 * @param {{ service: import('./service.js').OverwatchService, rest: string[], url: URL, res: import('node:http').ServerResponse, head: boolean }} input
 */
async function handleRead(input) {
  const { service, rest, url, res, head } = input
  const asOf = new Date().toISOString()

  if (rest.length === 1 && rest[0] === 'health') {
    sendJson(res, 200, { ...service.health(), asOf: asOf }, head)
    return
  }
  if (rest.length === 1 && rest[0] === 'doctor') {
    const doctor = await service.doctor()
    sendJson(res, 200, { ...doctor, asOf: doctor.asOf ?? asOf }, head)
    return
  }
  if (rest.length >= 1 && rest[0] === 'fish' && rest.length <= 2) {
    const sourceId = rest.length === 2 ? validateFishSourceId(rest[1]) : undefined
    const index = service.fishIndex(sourceId)
    if (sourceId !== undefined && index.sources.length === 0) {
      sendJson(res, 404, errorBody('FISH_SOURCE_NOT_FOUND', `fish source ${sourceId} not found`), head)
      return
    }
    sendJson(res, 200, { ok: true, data: index, asOf: index.asOf ?? asOf }, head)
    return
  }
  if (rest.length === 2 && rest[0] === 'watch' && rest[1] === 'verify') {
    sendJson(res, 200, { ok: true, data: service.health().service.watch, asOf }, head)
    return
  }
  if (rest.length === 1 && rest[0] === 'watch') {
    const since = intParam(url, 'since', 0, 0)
    const limit = intParam(url, 'limit', 200, 1, 1_000)
    sendJson(res, 200, { ok: true, data: { events: service.watchEvents({ since, limit }) }, asOf }, head)
    return
  }
  if (rest.length === 1 && rest[0] === 'runs') {
    sendJson(res, 200, { ok: true, data: { runs: service.listRuns() }, asOf }, head)
    return
  }
  if (rest[0] !== 'runs' || rest.length < 2) {
    sendJson(res, 404, errorBody('NOT_FOUND', 'unknown overwatch route'), head)
    return
  }
  const runId = validateParam(rest[1], 'runId')
  const asOfForRun = asOf

  if (rest.length === 2) {
    const view = service.getRun(runId)
    if (view === null) {
      sendJson(res, 404, errorBody('RUN_NOT_FOUND', `run ${runId} not found`), head)
      return
    }
    sendJson(res, 200, { ok: true, data: { ...view, asOf: asOfForRun } }, head)
    return
  }
  if (rest.length === 3 && rest[2] === 'cases') {
    const state = url.searchParams.get('state') ?? 'all'
    const limit = intParam(url, 'limit', 100, 1, 500)
    const cases = service.cases(runId, { state, limit })
    sendJson(res, 200, { ok: true, data: { cases, asOf: asOfForRun } }, head)
    return
  }
  if (rest.length === 3 && rest[2] === 'timeline') {
    const since = sinceParam(url)
    const limit = intParam(url, 'limit', 100, 1, 500)
    const page = service.timeline(runId, { since, limit })
    sendJson(res, 200, { ok: true, data: { ...page, asOf: asOfForRun } }, head)
    return
  }
  if (rest.length === 3 && rest[2] === 'export') {
    const cases = service.cases(runId, { state: 'all', limit: 500 })
    const timeline = service.timeline(runId, { since: 0, limit: 500 })
    sendJson(res, 200, { ok: true, data: { runId, cases, timeline, report: service.report(runId), asOf: asOfForRun } }, head)
    return
  }
  if (rest.length === 4 && rest[2] === 'shift' && rest[3] === 'latest') {
    const format = url.searchParams.get('format') ?? 'json'
    if (format !== 'json' && format !== 'md') throw badRequest('format must be json or md')
    const report = service.report(runId)
    if (format === 'md') {
      sendText(res, 200, report, head)
      return
    }
    sendJson(res, 200, { ok: true, data: { runId, format: 'json', report, asOf: asOfForRun } }, head)
    return
  }
  if (rest.length === 4 && rest[2] === 'cases') {
    const caseId = validateParam(rest[3], 'caseId')
    const detail = service.caseDetail(runId, caseId)
    if (detail === null) {
      sendJson(res, 404, errorBody('CASE_NOT_FOUND', `case ${caseId} not found`), head)
      return
    }
    sendJson(res, 200, { ok: true, data: { ...detail, asOf: asOfForRun } }, head)
    return
  }
  sendJson(res, 404, errorBody('NOT_FOUND', 'unknown overwatch route'), head)
}

/**
 * @param {{ service: import('./service.js').OverwatchService, rest: string[], url: URL, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse }} input
 */
async function handleWrite(input) {
  const { service, rest, req, res } = input
  if (rest[0] !== 'runs' || rest.length < 3) {
    sendJson(res, 404, errorBody('NOT_FOUND', 'unknown overwatch write route'))
    return
  }
  const runId = validateParam(rest[1], 'runId')
  const action = rest[2]
  const body = await readJsonBody(req)

  if (action === 'arm' && rest.length === 3) {
    const result = await service.arm({
      runId,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    })
    sendJson(res, 200, { ok: true, data: result })
    return
  }
  if (action === 'disarm' && rest.length === 3) {
    const result = await service.disarm(runId, typeof body.reason === 'string' ? body.reason : 'disarmed via HTTP')
    sendJson(res, 200, { ok: true, data: result })
    return
  }
  if (action === 'cases' && rest.length === 5 && rest[4] === 'ack') {
    const caseId = validateParam(rest[3], 'caseId')
    const record = service.acknowledge(runId, caseId, typeof body.note === 'string' ? body.note : '')
    sendJson(res, 200, { ok: true, data: { case: record } })
    return
  }
  if (action === 'purge' && rest.length === 3) {
    sendJson(res, 501, errorBody('NOT_IMPLEMENTED', 'purge is not implemented in M1; data is retained'))
    return
  }
  if (action === 'restores' && rest.length === 3) {
    const result = service.recordRestore(runId, body)
    sendJson(res, 200, { ok: true, data: result })
    return
  }
  sendJson(res, 404, errorBody('NOT_FOUND', 'unknown overwatch write route'))
}

/** @param {import('node:http').IncomingMessage} req */
async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'BODY_TOO_LARGE', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  if (!contentType.startsWith('application/json')) throw badRequest('content-type must be application/json')
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw badRequest('request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest('request body must be a JSON object')
  return value
}

/** @param {string} raw @param {string} name */
function validateParam(raw, name) {
  const value = decodeURIComponent(raw)
  if (!RUN_ID.test(value)) throw badRequest(`${name} must match [A-Za-z0-9_-]{1,200}`)
  return value
}

/**
 * Timeline cursor: 0/absent or a legacy index for the first call, then the
 * opaque `nextSince` string produced by the server.
 * @param {URL} url
 * @returns {number | string}
 */
function sinceParam(url) {
  const raw = url.searchParams.get('since')
  if (raw === null || raw === '' || raw === '0') return 0
  if (raw.length > 300) throw badRequest('since must be at most 300 characters')
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(value) || value < 0) throw badRequest('since must be a non-negative integer or an opaque cursor')
    return value
  }
  return raw
}

/** fishkeeper source ids allow dots and colons as well. @param {string} raw */
function validateFishSourceId(raw) {
  const value = decodeURIComponent(raw)
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw badRequest('sourceId must match [A-Za-z0-9._:-]{1,200}')
  return value
}

/** @param {URL} url @param {string} name @param {number} fallback @param {number} min @param {number} [max] */
function intParam(url, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min || value > max) throw badRequest(`${name} must be an integer between ${min} and ${max}`)
  return value
}

/** @param {string} code */
function statusFor(code) {
  if (code === 'INVALID_ARGUMENT' || code === 'INVALID_BODY' || code.startsWith('INVALID_')) return 400
  if (code === 'RESTORE_TOKEN_REJECTED' || code === 'INVALID_RESTORE') return 400
  if (code === 'NOT_FOUND' || code === 'RUN_NOT_FOUND' || code === 'CASE_NOT_FOUND' || code === 'FISH_SOURCE_NOT_FOUND') return 404
  if (code === 'ALREADY_ARMED' || code === 'RUN_NOT_ARMED' || code === 'RUN_NOT_RUNNING' || code === 'CASE_CLOSED' || code === 'ELOCKED' || code === 'SUPERVISOR_UNAVAILABLE') return 409
  if (code === 'SWARM_UNAVAILABLE' || code === 'WEB_UNAVAILABLE' || code === 'SERVICE_LOG_CLOSED') return 503
  if (code === 'BODY_TOO_LARGE') return 413
  return 500
}

/** @param {number} status @param {string} code @param {string} message */
function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** @param {string} message */
function badRequest(message) {
  return httpError(400, 'INVALID_ARGUMENT', message)
}

/** @param {string} code @param {string} message */
function errorBody(code, message) {
  return { ok: false, code, message }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {boolean} [head]
 */
function sendJson(res, status, body, head = false) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(head ? undefined : text)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {boolean} [head]
 */
function sendText(res, status, text, head = false) {
  res.writeHead(status, {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(head ? undefined : text)
}
