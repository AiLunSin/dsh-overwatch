/**
 * Standalone state-machine test for the fake swarm HTTP handlers.
 *
 * This does not need DSH and does not spawn any process: it starts a loopback
 * `node:http` server, mounts the same prefix handlers `apply` mounts, and drives
 * health, snapshot, events, auth, pause/resume/steer/abort, and the test control
 * plane with `fetch`.
 *
 * Run with:
 *   node e2e/m1/test-fake-swarm.mjs
 * @module dsh-overwatch/e2e/m1/test-fake-swarm
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, RUN_ID, TOKEN, VERSION } from './fake-swarm/index.js'

const TEST_TOKEN = 'm1-swarm-token'
let checks = 0

/** @param {string} label @param {unknown} actual @param {unknown} expected */
function equal(label, actual, expected) {
  assert.deepEqual(actual, expected, label)
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

/** @param {string} label @param {unknown} value */
function truthy(label, value) {
  assert.ok(value, label)
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

/** @param {string} label @param {unknown} value */
function falsy(label, value) {
  assert.ok(!value, label)
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

/** @param {any} value @param {string} label */
function hasKeys(value, keys, label) {
  for (const key of keys) assert.ok(key in value, `${label}: missing ${key}`)
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

const routes = []
const server = createServer((req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(candidate => candidate.kind === 'prefix'
      ? pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)
      : pathname === candidate.path)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no test route' } }))
      return
    }
    Promise.resolve(route.handler(req, res)).catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'TEST_HARNESS', message: String(error) } }))
    })
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'TEST_HARNESS', message: String(error) } }))
  }
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port')
const origin = `http://127.0.0.1:${address.port}`
const webServer = {
  getOrigin() {
    return origin
  },
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}
const effects = []
const ctx = {
  logger: { info() {}, warn(message) { console.error(`warn: ${message}`) }, error(message) { console.error(`error: ${message}`) } },
  get(name) {
    return name === 'webServer' ? webServer : undefined
  },
  inject() {
    throw new Error('the test mounts webServer synchronously')
  },
  effect(callback) {
    effects.push(callback())
  },
}

/** @param {string} method @param {string} pathname @param {{ body?: unknown, token?: string, origin?: string, contentType?: string }} [options] */
async function request(method, pathname, options = {}) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (options.body !== undefined) headers['content-type'] = options.contentType ?? 'application/json'
  if (options.token !== undefined) headers['x-swarm-token'] = options.token
  if (options.origin !== undefined) headers.origin = options.origin
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  /** @type {any} */
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body }
}

try {
  apply(ctx, { token: TEST_TOKEN })
  equal('apply mounts two prefix routes', routes.length, 2)
  truthy('webServer service is used synchronously', routes.every(route => route.kind === 'prefix'))

  const health = await request('GET', '/swarm/api/health')
  equal('health status', health.status, 200)
  equal('health body', health.body, { ok: true, version: VERSION, runs: 1 })

  const runs = await request('GET', '/swarm/api/runs')
  equal('runs status', runs.status, 200)
  equal('runs has one entry', runs.body.runs.length, 1)
  equal('runs entry run id', runs.body.runs[0].swarmId, RUN_ID)
  equal('runs entry status', runs.body.runs[0].status, 'running')
  equal('runs entry members', runs.body.runs[0].members, 3)

  const snapshot = await request('GET', `/swarm/api/runs/${RUN_ID}?detail=false`)
  equal('snapshot status', snapshot.status, 200)
  hasKeys(snapshot.body, ['swarmId', 'runId', 'goal', 'status', 'round', 'createdAt', 'updatedAt', 'budget', 'members', 'tasks', 'stats', 'workspace', 'dispatch', 'convergence'], 'snapshot core keys')
  equal('snapshot run id', snapshot.body.runId, RUN_ID)
  equal('snapshot goal', snapshot.body.goal, 'M1 fake run')
  equal('snapshot budget limit', snapshot.body.budget.limits.runTokens, 1_000_000)
  equal('snapshot budget initial tokens', snapshot.body.budget.run.tokens, 250_000)
  equal('snapshot budget reservations', snapshot.body.budget.reservations, 0)
  equal('snapshot convergence ratio', snapshot.body.convergence.budgetRatio, 0.25)
  equal('snapshot convergence not exhausted', snapshot.body.convergence.budgetExhausted, false)
  equal('snapshot queen member', snapshot.body.members[0].id, 'mem_queen')
  equal('snapshot stats members', snapshot.body.stats.members, 3)

  const events = await request('GET', `/swarm/api/runs/${RUN_ID}/events?since=0&limit=200`)
  equal('events status', events.status, 200)
  equal('events run id', events.body.runId, RUN_ID)
  truthy('events has seq 1', events.body.events[0].seq === 1)
  truthy('events include status changed', events.body.events.some(event => event.type === 'swarm/status/changed'))
  truthy('events include dispatch started', events.body.events.some(event => event.type === 'swarm/dispatch/started'))
  const seqs = events.body.events.map(event => event.seq)
  equal('events seq is monotonic', seqs, seqs.map((_value, index) => index + 1))

  const since = await request('GET', `/swarm/api/runs/${RUN_ID}/events?since=2&limit=1`)
  equal('events since/limit status', since.status, 200)
  equal('events since/limit length', since.body.events.length, 1)
  equal('events since/limit seq', since.body.events[0].seq, 3)

  const noToken = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { body: { action: 'pause' } })
  equal('intervene without token is 401', noToken.status, 401)
  equal('intervene without token code', noToken.body.error.code, 'UNAUTHORIZED')

  const wrongToken = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: 'wrong', body: { action: 'pause' } })
  equal('intervene with wrong token is 401', wrongToken.status, 401)

  const crossOrigin = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, {
    token: TEST_TOKEN,
    origin: 'https://evil.example',
    body: { action: 'pause' },
  })
  equal('intervene cross-origin is 403', crossOrigin.status, 403)
  equal('intervene cross-origin code', crossOrigin.body.error.code, 'CROSS_ORIGIN')

  const noContentType = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, {
    token: TEST_TOKEN,
    contentType: 'text/plain',
    body: { action: 'pause' },
  })
  equal('intervene without JSON content-type is 400', noContentType.status, 400)
  equal('intervene content-type code', noContentType.body.error.code, 'INVALID_CONTENT_TYPE')

  const paused = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, {
    token: TEST_TOKEN,
    body: { action: 'pause', reason: 'test pause', actor: 'probe' },
  })
  equal('pause status', paused.status, 200)
  equal('pause snapshot status', paused.body.status, 'paused')

  const pausedAgain = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'pause' } })
  equal('pause twice is 409', pausedAgain.status, 409)
  equal('pause twice code', pausedAgain.body.error.code, 'RUN_NOT_RUNNING')

  const resumed = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'resume' } })
  equal('resume status', resumed.status, 200)
  equal('resume snapshot status', resumed.body.status, 'running')

  const steered = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'steer', text: 'slow down' } })
  equal('steer status', steered.status, 200)
  equal('steer keeps running', steered.body.status, 'running')

  const invalidAction = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'explode' } })
  equal('unknown action is 400', invalidAction.status, 400)
  equal('unknown action code', invalidAction.body.error.code, 'INVALID_ACTION')

  const budget = await request('POST', '/fake/api/budget', { body: { ratio: 0.81 } })
  equal('budget set status', budget.status, 200)
  equal('budget set tokens', budget.body.tokens, 810_000)
  const afterBudget = await request('GET', `/swarm/api/runs/${RUN_ID}`)
  equal('budget reflected in snapshot', afterBudget.body.budget.run.tokens, 810_000)
  equal('budget ratio in convergence', afterBudget.body.convergence.budgetRatio, 0.81)
  equal('budget does not change status', afterBudget.body.status, 'running')

  const fakeState = await request('GET', '/fake/api/state')
  equal('fake state status', fakeState.status, 200)
  hasKeys(fakeState.body, ['status', 'budgetRatio', 'calls', 'events'], 'fake state core keys')
  equal('fake state budget ratio', fakeState.body.budgetRatio, 0.81)
  equal('fake state status value', fakeState.body.status, 'running')
  equal('fake state records calls', fakeState.body.calls.map(call => call.action), ['pause', 'pause', 'resume', 'steer', 'explode'])
  equal('fake state call statuses', fakeState.body.calls.map(call => call.httpStatus), [200, 409, 200, 200, 400])
  truthy('fake state includes events', fakeState.body.events.some(event => event.type === 'swarm/budget/sampled'))
  truthy('fake state includes steer event', fakeState.body.events.some(event => event.type === 'swarm/intervened'))

  const aborted = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'abort', reason: 'test abort' } })
  equal('abort status', aborted.status, 200)
  equal('abort snapshot status', aborted.body.status, 'aborted')
  const abortedAgain = await request('POST', `/swarm/api/runs/${RUN_ID}/intervene`, { token: TEST_TOKEN, body: { action: 'abort' } })
  equal('abort twice is 409', abortedAgain.status, 409)
  equal('abort twice code', abortedAgain.body.error.code, 'RUN_ENDED')

  const completed = await request('GET', `/swarm/api/runs/${RUN_ID}/events?since=0&limit=1000`)
  truthy('events include abort', completed.body.events.some(event => event.type === 'swarm/aborted'))
  const completedSeqs = completed.body.events.map(event => event.seq)
  equal('events remain monotonic after transitions', completedSeqs, completedSeqs.map((_value, index) => index + 1))

  const statusControl = await request('POST', '/fake/api/status', { body: { status: 'paused' } })
  equal('status control status', statusControl.status, 200)
  equal('status control value', statusControl.body.status, 'paused')
  const stateAfterControl = await request('GET', '/fake/api/state')
  equal('status control reflected', stateAfterControl.body.status, 'paused')

  const badBudget = await request('POST', '/fake/api/budget', { body: { ratio: 'high' } })
  equal('invalid budget is 400', badBudget.status, 400)
  equal('invalid budget code', badBudget.body.error.code, 'INVALID_RATIO')

  const badStatus = await request('POST', '/fake/api/status', { body: { status: 'exploded' } })
  equal('invalid status is 400', badStatus.status, 400)

  const unknown = await request('GET', '/swarm/api/nope')
  equal('unknown swarm route is 404', unknown.status, 404)
  const unknownFake = await request('GET', '/fake/api/nope')
  equal('unknown fake route is 404', unknownFake.status, 404)

  // Non-loopback behavior cannot be exercised from this process: fetch always
  // leaves 127.0.0.1. It is covered by the explicit isLoopback checks in code.
  for (const dispose of effects) dispose()
  equal('dispose removes both routes', routes.length, 0)
  console.log(`\nfake-swarm: ${checks} checks passed`)
} catch (error) {
  console.error(`\nfake-swarm: FAILED after ${checks} checks`)
  console.error(error)
  process.exitCode = 1
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(() => resolve(undefined)))
}
