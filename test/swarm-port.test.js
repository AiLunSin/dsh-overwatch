import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SwarmPort } from '../src/ports/swarm.js'

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('swarm writes use the trusted executor runId, not a model-chosen params.runId', async () => {
  const calls = []
  const port = new SwarmPort({ origin: 'http://127.0.0.1:9999', token: 'secret', fetchImpl: fakeFetch(calls) })
  const result = await port.apply({
    schemaVersion: 1,
    caseId: 'case-1',
    action: 'pause',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: { runId: 'other-run' },
    evidenceRefs: ['ev-1'],
    reason: 'pause the supervised run',
  }, { actionId: 'act_1', runId: 'run-1' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/swarm\/api\/runs\/run-1\/intervene$/)
  assert.doesNotMatch(calls[0].url, /other-run/)
  assert.equal(calls[0].init.headers['x-swarm-token'], 'secret')
})
