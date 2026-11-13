/**
 * Fake dsh-swarm HTTP surface for the dsh-overwatch M1 real-host probe.
 *
 * The real `dsh-swarm` is a separate bundle; the M1 probe must run against a
 * real Host web server without installing a real swarm run. This plugin mounts
 * the smallest read/write subset that `dsh-overwatch` actually consumes on
 * `ctx.webServer`, plus a loopback-only test control plane:
 *
 * - `GET  /swarm/api/health`
 * - `GET  /swarm/api/runs`
 * - `GET  /swarm/api/runs/swarm_m1?detail=false`
 * - `GET  /swarm/api/runs/swarm_m1/events?since=&limit=`
 * - `POST /swarm/api/runs/swarm_m1/intervene`
 * - `POST /fake/api/budget` / `POST /fake/api/status` / `GET /fake/api/state`
 *
 * The snapshot shape mirrors the real `SwarmService.#snapshotState` fields the
 * supervisor reads (budget ledger, members, convergence); it is deliberately
 * not a general-purpose swarm emulator. Test only; never published.
 * @module dsh-overwatch-m1-fake-swarm
 */

import { timingSafeEqual } from 'node:crypto'

export const name = 'dsh-overwatch-m1-fake-swarm'

/** No hard dependency: the web server may mount after this plugin row. */
export const inject = []

export const RUN_ID = 'swarm_m1'
export const TOKEN = 'm1-swarm-token'
export const VERSION = 'fake-0.1.0'

const DEFAULT_LIMITS = Object.freeze({
  runTokens: 1_000_000,
  runUsd: 10,
  runWallMs: 3_600_000,
  taskTokens: 100_000,
  memberTokens: 50_000,
})

const START_RATIO = 0.25
const ACTIVE_STATUSES = new Set(['created', 'running', 'paused', 'draining'])
const WRITABLE_STATUSES = new Set(['created', 'running', 'paused', 'aborted', 'converged'])

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** @param {unknown} address */
function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** @param {number} value @param {number} digits */
function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Create one fake swarm. Kept separate from `apply` so a plain Node test can
 * mount the same handlers without DSH.
 * @param {{ token?: string, clock?: () => number, logger?: { info?: (message: string) => void, warn?: (message: string) => void } }} [options]
 */
export function createFakeSwarm(options = {}) {
  const clock = options.clock ?? Date.now
  const logger = options.logger
  const token = typeof options.token === 'string' ? options.token : TOKEN
  const startedAt = clock()

  /** @type {any} */
  const state = {
    status: 'running',
    round: 1,
    goal: 'M1 fake run',
    ratio: START_RATIO,
    createdAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    members: [
      { id: 'mem_queen', name: 'queen', role: 'queen', status: 'idle', model: 'inherit', load: 0, joinedAt: startedAt },
      { id: 'mem_worker_1', name: 'worker-1', role: 'worker', status: 'idle', model: 'fast', load: 0, joinedAt: startedAt + 1 },
      { id: 'mem_worker_2', name: 'worker-2', role: 'worker', status: 'idle', model: 'fast', load: 0, joinedAt: startedAt + 2 },
    ],
    budget: {
      limits: { ...DEFAULT_LIMITS },
      run: {
        tokens: Math.round(START_RATIO * DEFAULT_LIMITS.runTokens),
        reservedTokens: 0,
        calls: 3,
        usd: round(START_RATIO * DEFAULT_LIMITS.runUsd, 6),
        reservedUsd: 0,
        wallMs: 60_000,
      },
      tasks: {},
      members: {},
      reservations: 0,
    },
    /** @type {Array<{ seq: number, id: string, type: string, at: string, actor: string, payload: unknown }>} */
    events: [],
    seq: 0,
    /** @type {Array<Record<string, unknown>>} */
    calls: [],
  }

  /**
   * Append one event, keeping `seq` strictly monotonic and mirrored in
   * `stats.events`. This is the only path that advances time.
   * @param {string} type
   * @param {unknown} payload
   * @param {string} [actor]
   */
  function appendEvent(type, payload, actor = 'system') {
    const seq = state.seq + 1
    const at = new Date(clock()).toISOString()
    const event = { seq, id: `evt_m1_${seq}`, type, at, actor, payload }
    state.seq = seq
    state.events.push(event)
    state.updatedAt = at
    return event
  }

  /**
   * Change status and record the transition. `abort` additionally mirrors the
   * real `swarm/aborted` event before the status change.
   * @param {string} to
   * @param {string} [reason]
   */
  function setStatus(to, reason = '') {
    const from = state.status
    if (from === to) return
    if (to === 'aborted') {
      state.status = to
      appendEvent('swarm/aborted', { reason: reason || 'aborted', from }, 'human')
      appendEvent('swarm/status/changed', { from, to, reason: reason || 'aborted' }, 'system')
      return
    }
    state.status = to
    appendEvent('swarm/status/changed', { from, to, reason }, 'system')
  }

  /**
   * Drive the run budget from the test control plane. `tokens` is the product
   * the supervisor will read back, so a ratio of 0.96 is observable as 96% of
   * the advertised `budget.limits.runTokens`.
   * @param {number} ratio
   */
  function setBudgetRatio(ratio) {
    state.ratio = ratio
    state.budget.run.tokens = Math.round(ratio * state.budget.limits.runTokens)
    state.budget.run.usd = round(ratio * state.budget.limits.runUsd, 6)
    appendEvent(
      'swarm/budget/sampled',
      {
        scope: 'run',
        ratio: round(ratio, 4),
        tokens: state.budget.run.tokens,
        limit: state.budget.limits.runTokens,
        usd: state.budget.run.usd,
        usdLimit: state.budget.limits.runUsd,
      },
      'system',
    )
  }

  /** Seed the stream with the two event types the guard's event sampler expects. */
  appendEvent(
    'swarm/created',
    {
      goal: state.goal,
      repo: 'C:\\fake\\swarm_m1',
      topology: 'mesh',
      mode: 'swarm',
      limits: { ...state.budget.limits },
    },
    'human',
  )
  appendEvent('swarm/status/changed', { from: 'created', to: 'running' }, 'system')
  appendEvent('swarm/dispatch/started', { taskId: 'task_m1_1', memberId: 'mem_worker_1', childId: 'child_m1_1' }, 'mem_worker_1')

  /** The minimal real-swarm snapshot shape the supervisor reads. */
  function snapshot() {
    return {
      swarmId: RUN_ID,
      runId: RUN_ID,
      goal: state.goal,
      repo: 'C:\\fake\\swarm_m1',
      topology: 'mesh',
      mode: 'swarm',
      status: state.status,
      round: state.round,
      concurrencyLimit: 3,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      endedAt: state.status === 'aborted' ? state.updatedAt : null,
      budget: {
        limits: { ...state.budget.limits },
        run: { ...state.budget.run },
        tasks: {},
        members: {},
        reservations: 0,
      },
      members: state.members.map(member => ({ ...member })),
      tasks: [],
      stats: {
        members: state.members.length,
        tasks: 0,
        merged: 0,
        failed: 0,
        active: 0,
        boardEntries: 0,
        events: state.events.length,
      },
      workspace: {
        enabled: false,
        integrationBranch: null,
        degraded: 0,
        conflicts: 0,
      },
      dispatch: {
        auto: false,
        active: 0,
        parentBound: false,
      },
      convergence: {
        converged: false,
        openTasks: 1,
        budgetRatio: round(state.ratio, 3),
        budgetExhausted: state.ratio >= 1,
      },
    }
  }

  /** @param {unknown} value @returns {string} */
  function json(value) {
    return JSON.stringify(value)
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  function sendJson(res, status, body) {
    const text = json(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  function sendJsonIfOpen(res, status, body) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, status, body)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {number} [maxBytes]
   * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, status: number, code: string, message: string }>}
   */
  async function readJsonBody(req, maxBytes = 256 * 1024) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      return { ok: false, status: 400, code: 'INVALID_CONTENT_TYPE', message: 'content-type must be application/json' }
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: 'request body is too large' }
      }
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return { ok: true, value: {} }
    try {
      const value = JSON.parse(text)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, status: 400, code: 'INVALID_JSON', message: 'request body must be a JSON object' }
      }
      return { ok: true, value: /** @type {Record<string, unknown>} */ (value) }
    } catch (error) {
      return { ok: false, status: 400, code: 'INVALID_JSON', message: `request body is not valid JSON: ${errorMessage(error)}` }
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  function suppliedToken(req) {
    const direct = req.headers['x-swarm-token']
    if (typeof direct === 'string') return direct
    const bearer = req.headers.authorization
    if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim()
    return ''
  }

  /** @param {import('node:http').IncomingMessage} req */
  function authorized(req) {
    if (token === '') return 'disabled'
    const supplied = suppliedToken(req)
    if (supplied === '') return false
    const left = Buffer.from(supplied)
    const right = Buffer.from(token)
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  function fail(req, res, code, message, status = 400) {
    sendJsonIfOpen(res, status, { error: { code, message } })
  }

  /**
   * Route one `/swarm/api` request. The real swarm handler is intentionally
   * copied where it matters: loopback-only, write token, same-origin POST.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleSwarm(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: { code: 'LOOPBACK_ONLY', message: 'swarm API is local-only' } })
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`
      const url = new URL(req.url ?? '/', origin)
      const pathname = url.pathname

      if (method === 'POST') {
        if (req.headers.origin && req.headers.origin !== origin) {
          fail(req, res, 'CROSS_ORIGIN', 'cross-origin writes are not allowed', 403)
          return
        }
        const auth = authorized(req)
        if (auth === 'disabled') {
          fail(req, res, 'WRITE_DISABLED', 'write API is disabled; configure token', 403)
          return
        }
        if (auth !== true) {
          fail(req, res, 'UNAUTHORIZED', 'missing or invalid swarm API token', 401)
          return
        }
        const body = await readJsonBody(req)
        if (body.ok === false) {
          fail(req, res, body.code, body.message, body.status)
          return
        }
        if (pathname !== `/swarm/api/runs/${RUN_ID}/intervene`) {
          fail(req, res, 'NOT_FOUND', `no write route ${pathname}`, 404)
          return
        }
        intervene(body.value, req, res)
        return
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or POST' } })
        return
      }

      if (pathname === '/swarm/api/health') {
        sendJson(res, 200, { ok: true, version: VERSION, runs: 1 })
        return
      }
      if (pathname === '/swarm/api/runs') {
        sendJson(res, 200, {
          runs: [{
            swarmId: RUN_ID,
            goal: state.goal,
            status: state.status,
            tasks: 0,
            members: state.members.length,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          }],
        })
        return
      }
      if (pathname === `/swarm/api/runs/${RUN_ID}`) {
        sendJson(res, 200, snapshot())
        return
      }
      if (pathname === `/swarm/api/runs/${RUN_ID}/events`) {
        const sinceRaw = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
        const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
        const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0
        const limit = Number.isFinite(limitRaw) ? Math.min(1_000, Math.max(1, limitRaw)) : 200
        const events = state.events.filter(event => event.seq > since).slice(0, limit)
        sendJson(res, 200, { runId: RUN_ID, events })
        return
      }
      if (pathname.startsWith('/swarm/api/runs/')) {
        fail(req, res, 'RUN_NOT_FOUND', `swarm run not found for ${pathname}`, 404)
        return
      }
      fail(req, res, 'NOT_FOUND', `no route ${pathname}`, 404)
    } catch (error) {
      logger?.warn?.(`[fake-swarm] /swarm/api request failed: ${errorMessage(error)}`)
      sendJsonIfOpen(res, 500, { error: { code: 'INTERNAL', message: errorMessage(error) } })
    }
  }

  /**
   * @param {Record<string, unknown>} body
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function intervene(body, req, res) {
    const action = typeof body.action === 'string' ? body.action : ''
    const actor = typeof body.actor === 'string' && body.actor !== '' ? body.actor : 'human'
    const reason = typeof body.reason === 'string' ? body.reason : ''
    const from = state.status
    /** @type {Record<string, unknown>} */
    const call = {
      at: new Date(clock()).toISOString(),
      action,
      actor,
      reason,
      text: typeof body.text === 'string' ? body.text : '',
      target: body.target ?? null,
      from,
      to: from,
      httpStatus: 200,
      ok: true,
      remoteAddress: req.socket?.remoteAddress ?? null,
    }
    state.calls.push(call)

    if (action === 'pause') {
      if (from !== 'running') {
        call.ok = false
        call.httpStatus = 409
        call.error = 'RUN_NOT_RUNNING'
        fail(req, res, 'RUN_NOT_RUNNING', `swarm is ${from}; pause requires running`, 409)
        return
      }
      state.status = 'paused'
      call.to = 'paused'
      appendEvent('swarm/status/changed', { from, to: 'paused', reason }, actor)
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'resume') {
      if (from !== 'paused') {
        call.ok = false
        call.httpStatus = 409
        call.error = 'RUN_NOT_RUNNING'
        fail(req, res, 'RUN_NOT_RUNNING', `swarm is ${from}; resume requires paused`, 409)
        return
      }
      state.status = 'running'
      call.to = 'running'
      appendEvent('swarm/status/changed', { from, to: 'running', reason }, actor)
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'steer') {
      if (!ACTIVE_STATUSES.has(from)) {
        call.ok = false
        call.httpStatus = 409
        call.error = 'RUN_ENDED'
        fail(req, res, 'RUN_ENDED', `swarm is ${from}`, 409)
        return
      }
      appendEvent(
        'swarm/intervened',
        { action: 'steer', text: call.text, reason, target: body.target ?? null },
        actor,
      )
      sendJson(res, 200, snapshot())
      return
    }
    if (action === 'abort') {
      if (from === 'aborted' || from === 'converged' || from === 'ended') {
        call.ok = false
        call.httpStatus = 409
        call.error = 'RUN_ENDED'
        fail(req, res, 'RUN_ENDED', `swarm is ${from}`, 409)
        return
      }
      state.status = 'aborted'
      call.to = 'aborted'
      appendEvent('swarm/aborted', { reason: reason || 'aborted', from }, actor)
      appendEvent('swarm/status/changed', { from, to: 'aborted', reason: reason || 'aborted' }, 'system')
      sendJson(res, 200, snapshot())
      return
    }

    call.ok = false
    call.httpStatus = 400
    call.error = 'INVALID_ACTION'
    fail(req, res, 'INVALID_ACTION', `unknown intervene action '${action}'`, 400)
  }

  /**
   * Route one `/fake/api` request. Loopback only; no token, because this is a
   * test control plane and never reaches a published build.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleFake(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: { code: 'LOOPBACK_ONLY', message: 'fake control plane is local-only' } })
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const pathname = url.pathname

      if (method === 'GET' && pathname === '/fake/api/state') {
        sendJson(res, 200, {
          status: state.status,
          budgetRatio: round(state.ratio, 3),
          calls: state.calls,
          events: state.events,
        })
        return
      }
      if (method === 'POST' && pathname === '/fake/api/budget') {
        const body = await readJsonBody(req)
        if (body.ok === false) {
          fail(req, res, body.code, body.message, body.status)
          return
        }
        const ratio = Number(body.value.ratio)
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 10) {
          fail(req, res, 'INVALID_RATIO', 'ratio must be a finite number between 0 and 10', 400)
          return
        }
        setBudgetRatio(ratio)
        sendJson(res, 200, {
          ok: true,
          ratio: round(ratio, 3),
          tokens: state.budget.run.tokens,
          status: state.status,
          updatedAt: state.updatedAt,
        })
        return
      }
      if (method === 'POST' && pathname === '/fake/api/status') {
        const body = await readJsonBody(req)
        if (body.ok === false) {
          fail(req, res, body.code, body.message, body.status)
          return
        }
        const status = typeof body.value.status === 'string' ? body.value.status : ''
        if (!WRITABLE_STATUSES.has(status)) {
          fail(req, res, 'INVALID_STATUS', `status must be one of ${[...WRITABLE_STATUSES].join(', ')}`, 400)
          return
        }
        setStatus(status, typeof body.value.reason === 'string' ? body.value.reason : 'fake control')
        sendJson(res, 200, { ok: true, status: state.status, updatedAt: state.updatedAt })
        return
      }
      fail(req, res, 'NOT_FOUND', `no fake route ${method} ${pathname}`, 404)
    } catch (error) {
      logger?.warn?.(`[fake-swarm] /fake/api request failed: ${errorMessage(error)}`)
      sendJsonIfOpen(res, 500, { error: { code: 'INTERNAL', message: errorMessage(error) } })
    }
  }

  return { state, snapshot, appendEvent, setBudgetRatio, setStatus, handleSwarm, handleFake }
}

/**
 * Mount the fake swarm on the Host web server. The two prefix routes are owned
 * by this plugin row and disposed with it.
 * @param {any} ctx Cordis Host context
 * @param {{ token?: string }} [rawConfig] profile config for this row
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const swarm = createFakeSwarm({ token: typeof config.token === 'string' ? config.token : TOKEN, logger: ctx.logger })
  /** @param {any} server */
  const register = server => {
    if (server === undefined || server === null || typeof server.register !== 'function') return
    ctx.effect(() => server.register({ kind: 'prefix', path: '/swarm/api', handler: swarm.handleSwarm }))
    ctx.effect(() => server.register({ kind: 'prefix', path: '/fake/api', handler: swarm.handleFake }))
    ctx.logger?.info?.('[fake-swarm] fake swarm API registered on the Host web server')
  }
  const webServer = ctx.get?.('webServer')
  if (webServer !== undefined && webServer !== null) register(webServer)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], webCtx => register(webCtx.webServer))
  else ctx.logger?.warn?.('[fake-swarm] webServer service is unavailable; fake swarm routes not mounted')
}
