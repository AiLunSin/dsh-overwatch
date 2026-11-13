import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { checkWriteRequest, createNodeHandler, isLoopback } from '../src/http.js'

/** @param {Record<string, string>} headers @param {string} remoteAddress */
function request(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('only loopback requests reach the API', () => {
  assert.equal(isLoopback(request()), true)
  assert.equal(isLoopback(request({}, '::1')), true)
  assert.equal(isLoopback(request({}, '::ffff:127.0.0.1')), true)
  assert.equal(isLoopback(request({}, '10.0.0.7')), false)
  const denied = checkWriteRequest(request({}, '10.0.0.7'), 'http://127.0.0.1:1', 'secret')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'LOOPBACK_ONLY')
})

test('an empty configured token disables writes entirely', () => {
  const result = checkWriteRequest(request(), 'http://127.0.0.1:1', '')
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.equal(result.code, 'WRITE_DISABLED')
})

test('a cross-origin write is rejected even with the right token', () => {
  const result = checkWriteRequest(
    request({ origin: 'https://evil.example', 'x-overwatch-token': 'secret' }),
    'http://127.0.0.1:1',
    'secret',
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CROSS_ORIGIN')
})

test('the token is compared exactly', () => {
  assert.equal(checkWriteRequest(request({ 'x-overwatch-token': 'wrong' }), 'http://127.0.0.1:1', 'secret').code, 'UNAUTHORIZED')
  assert.equal(checkWriteRequest(request({ 'x-overwatch-token': 'secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
  assert.equal(checkWriteRequest(request({ authorization: 'Bearer secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
  assert.equal(checkWriteRequest(request({ origin: 'http://127.0.0.1:1', 'x-overwatch-token': 'secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
})

/** A minimal stand-in for the real service, so these tests cover routing and auth only. */
function fakeService() {
  const calls = []
  return {
    calls,
    origin: () => 'http://127.0.0.1:1',
    health: () => ({ ok: true, version: '0.1.0', mode: 'guard', service: { watch: { ok: true, events: 2 } }, runs: [] }),
    listRuns: () => [{ runId: 'run-1', armed: true, state: 'watching', openCases: 1 }],
    getRun: runId => (runId === 'run-1' ? { runId, armed: true, state: 'watching', budget: { limit: 1_000, spent: 810, ratio: 0.81 } } : null),
    cases: (_runId, query) => [{ id: 'case-1', state: 'open', severity: 'L2', code: 'budget_pressure', query }],
    caseDetail: runId => (runId === 'run-1' ? { case: { id: 'case-1' }, timeline: [] } : null),
    timeline: () => ({ events: [], nextSince: 0, total: 0 }),
    report: () => '# report',
    watchEvents: () => [],
    async arm(input) {
      calls.push(['arm', input])
      return { runId: input.runId, mode: 'guard', state: 'watching', armed: true }
    },
    async disarm(runId, reason) {
      calls.push(['disarm', runId, reason])
      return { runId, state: 'disarmed' }
    },
    acknowledge(runId, caseId) {
      calls.push(['ack', runId, caseId])
      return { id: caseId, state: 'acknowledged' }
    },
  }
}

async function withServer(run) {
  const service = fakeService()
  let handler = null
  const server = createServer((req, res) => {
    if (handler === null) {
      res.writeHead(503)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  const origin = `http://127.0.0.1:${port}`
  service.origin = () => origin
  handler = createNodeHandler({ service, config: { http: { enabled: true, token: 'secret' } }, version: '0.1.0' })
  try {
    await run({ service, base: origin })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('read routes answer with the data envelope and 404 for unknown runs', async () => {
  await withServer(async ({ base, service }) => {
    const health = await fetch(`${base}/overwatch/api/health`)
    assert.equal(health.status, 200)
    const healthBody = await health.json()
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.mode, 'guard')

    const runs = await fetch(`${base}/overwatch/api/runs`)
    assert.equal(runs.status, 200)
    const runsBody = await runs.json()
    assert.equal(runsBody.data.runs[0].runId, 'run-1')

    const run = await fetch(`${base}/overwatch/api/runs/run-1`)
    const runBody = await run.json()
    assert.equal(runBody.data.budget.ratio, 0.81)

    const missing = await fetch(`${base}/overwatch/api/runs/missing`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, 'RUN_NOT_FOUND')

    const cases = await fetch(`${base}/overwatch/api/runs/run-1/cases?state=open`)
    assert.equal(cases.status, 200)
    assert.equal((await cases.json()).data.cases[0].code, 'budget_pressure')

    const detail = await fetch(`${base}/overwatch/api/runs/run-1/cases/case-1`)
    assert.equal(detail.status, 200)
    assert.equal((await detail.json()).data.case.id, 'case-1')

    const shift = await fetch(`${base}/overwatch/api/runs/run-1/shift/latest?format=md`)
    assert.equal(shift.status, 200)
    assert.equal(await shift.text(), '# report')
    assert.equal(service.calls.length, 0)
  })
})

test('write routes enforce token, origin, method and path shape', async () => {
  await withServer(async ({ base, service }) => {
    const noToken = await fetch(`${base}/overwatch/api/runs/run-1/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(noToken.status, 401)
    assert.equal((await noToken.json()).code, 'UNAUTHORIZED')

    const wrongToken = await fetch(`${base}/overwatch/api/runs/run-1/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-overwatch-token': 'wrong' },
      body: '{}',
    })
    assert.equal(wrongToken.status, 401)

    const crossOrigin = await fetch(`${base}/overwatch/api/runs/run-1/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-overwatch-token': 'secret' },
      body: '{}',
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await crossOrigin.json()).code, 'CROSS_ORIGIN')

    const badId = await fetch(`${base}/overwatch/api/runs/${encodeURIComponent('../etc')}/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-overwatch-token': 'secret' },
      body: '{}',
    })
    assert.equal(badId.status, 400)

    const armed = await fetch(`${base}/overwatch/api/runs/run-1/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-overwatch-token': 'secret' },
      body: JSON.stringify({ mode: 'guard' }),
    })
    assert.equal(armed.status, 200)
    assert.equal((await armed.json()).data.state, 'watching')
    assert.equal(service.calls[0][0], 'arm')
    assert.equal(service.calls[0][1].runId, 'run-1')
    assert.equal(service.calls[0][1].mode, 'guard')

    const disarmed = await fetch(`${base}/overwatch/api/runs/run-1/disarm`, {
      method: 'POST',
      headers: { 'x-overwatch-token': 'secret' },
    })
    assert.equal(disarmed.status, 200)
    assert.equal(service.calls[1][0], 'disarm')

    const ack = await fetch(`${base}/overwatch/api/runs/run-1/cases/case-1/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-overwatch-token': 'secret' },
      body: JSON.stringify({ note: 'seen' }),
    })
    assert.equal(ack.status, 200)
    assert.deepEqual(service.calls[2], ['ack', 'run-1', 'case-1'])
  })
})

test('HEAD returns headers without a body', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/overwatch/api/health`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
    assert.ok(Number(response.headers.get('content-length')) > 0)
  })
})
