import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { Executor } from '../src/executor.js'
import { WatchStore } from '../src/store.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-exec-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fakePort() {
  const calls = []
  const state = { paused: false, steers: 0 }
  return {
    calls,
    supports: decision => decision.target.kind === 'swarm_run',
    async apply(decision) {
      calls.push(decision.action)
      if (decision.action === 'pause') state.paused = true
      if (decision.action === 'throttle') state.steers += 1
      return { ok: true, httpStatus: 200 }
    },
    async verify(decision) {
      return { ok: decision.action === 'pause' ? state.paused : true, detail: { state } }
    },
  }
}

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: 'case-1',
    action: 'throttle',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: { runId: 'run-1', text: 'slow down' },
    evidenceRefs: ['ev-1'],
    reason: 'budget pressure',
    ...overrides,
  }
}

async function harness(policyMode = 'supervised') {
  const store = new WatchStore({ dir: tempDir(), runId: 'run-1', lockWaitMs: 10 })
  await store.open()
  const port = fakePort()
  const executor = new Executor({
    store,
    ports: [port],
    policy: { mode: policyMode, autopilot: { throttle: true, pause: false, abortOnHardLimit: true } },
  })
  return { store, port, executor }
}

test('a successful action records intent, execution and verification', async () => {
  const { store, port, executor } = await harness()
  const outcome = await executor.execute(decision(), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.verified, true)
  assert.deepEqual(port.calls, ['throttle'])
  const types = store.read().map(event => event.type)
  assert.deepEqual(types, ['watch/action/intended', 'watch/action/executed', 'watch/action/verified'])
  assert.equal(store.verify().ok, true)
  store.close()
})

test('a duplicate decision does not call the port twice', async () => {
  const { store, port, executor } = await harness()
  const first = await executor.execute(decision(), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  const second = await executor.execute(decision({ reason: 'same action, new words' }), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true)
  assert.deepEqual(port.calls, ['throttle'])
  store.close()
})

test('authorization denial is recorded and never reaches the port', async () => {
  const { store, port, executor } = await harness('observe')
  const outcome = await executor.execute(decision(), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'DENIED')
  assert.deepEqual(port.calls, [])
  assert.deepEqual(store.read().map(event => event.type), ['watch/decision/denied'])
  store.close()
})

test('invalid decisions and missing evidence never reach the port', async () => {
  const { store, port, executor } = await harness()
  const invalid = await executor.execute(decision({ action: 'teleport' }), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(invalid.code, 'INVALID_DECISION')
  const unknown = await executor.execute(decision({ evidenceRefs: ['ev-x'] }), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(unknown.code, 'INVALID_DECISION')
  assert.deepEqual(port.calls, [])
  assert.equal(store.read().length, 0)
  store.close()
})

test('recovery finds an intended-but-unexecuted action', async () => {
  const { store, executor } = await harness()
  await executor.execute(decision(), { caseId: 'case-1', evidenceIds: new Set(['ev-1']) })
  assert.equal(executor.recover().completed, 1)
  store.append({
    type: 'watch/action/intended',
    payload: { key: 'orphan', actionId: 'act_orphan', kind: 'throttle' },
  })
  const recovery = executor.recover()
  assert.deepEqual(recovery.incomplete, ['orphan'])
  store.close()
})
