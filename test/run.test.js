import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { RunSupervisor } from '../src/run.js'
import { readWatchLog } from '../src/store.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-run-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const LIMIT = 1_000_000

function fakePorts(initialRatio = 0) {
  const state = {
    status: 'running',
    spent: Math.round(LIMIT * initialRatio),
    calls: [],
    events: [],
    failures: 0,
    failHealth: false,
  }
  const swarm = {
    state,
    async health() {
      return state.failHealth
        ? { ok: false, status: 503, data: null, error: 'HTTP 503' }
        : { ok: true, status: 200, data: { ok: true, runs: 1 }, error: null }
    },
    async run() {
      return {
        ok: true,
        status: 200,
        data: {
          swarmId: 'run-1',
          runId: 'run-1',
          goal: 'M1 test run',
          status: state.status,
          round: 1,
          createdAt: Date.parse('2026-11-14T00:00:00.000Z'),
          updatedAt: Date.parse('2026-11-14T00:00:05.000Z'),
          budget: {
            limits: { runTokens: LIMIT, runUsd: 0, runWallMs: 0, taskTokens: 100_000, memberTokens: 100_000 },
            run: { tokens: state.spent, reservedTokens: 0, calls: 3, usd: 0, reservedUsd: 0, wallMs: 0 },
            tasks: {},
            members: {},
            reservations: 0,
          },
          members: [
            { id: 'mem_queen', name: 'queen', role: 'queen', status: 'busy', load: 0 },
            { id: 'mem_1', name: 'worker-1', role: 'worker', status: 'busy', load: 1 },
          ],
          tasks: [
            { id: 'task_1', state: 'working' },
            { id: 'task_2', state: 'queued' },
          ],
          workspace: { conflicts: 0 },
          dispatch: { auto: false, active: 1 },
          stats: { members: 2, tasks: 2, merged: 0, failed: 0, active: 2 },
        },
        error: null,
      }
    },
    async events(_runId, query = {}) {
      const since = query.since ?? 0
      const events = state.events.filter(event => event.seq > since).slice(0, query.limit ?? 200)
      return { ok: true, status: 200, data: { runId: 'run-1', events }, error: null }
    },
    async intervene(_runId, body) {
      state.calls.push({ action: body.action, reason: body.reason, text: body.text })
      if (body.action === 'pause') {
        if (state.status !== 'running') return { ok: false, status: 409, data: { error: { code: 'RUN_NOT_RUNNING' } }, error: 'HTTP 409' }
        state.status = 'paused'
      } else if (body.action === 'resume') {
        if (state.status !== 'paused') return { ok: false, status: 409, data: { error: { code: 'RUN_NOT_RUNNING' } }, error: 'HTTP 409' }
        state.status = 'running'
      } else if (body.action === 'abort') {
        state.status = 'aborted'
      }
      return { ok: true, status: 200, data: { runId: 'run-1', status: state.status }, error: null }
    },
    supports(decision) {
      return decision.target.kind === 'swarm_run'
    },
    async apply(decision, context) {
      const body = decision.action === 'throttle'
        ? { action: 'pause', reason: decision.reason, actor: 'overwatch' }
        : { action: decision.action, reason: decision.reason, actor: 'overwatch' }
      const response = await swarm.intervene('run-1', body)
      return { ok: response.ok, httpStatus: response.status, kind: body.action, error: response.error, actionId: context.actionId }
    },
    async verify(decision) {
      const expected = decision.action === 'resume' ? 'running' : decision.action === 'abort' ? 'aborted' : 'paused'
      return { ok: state.status === expected, detail: { status: state.status } }
    },
  }
  const pressure = {
    async live(sessionId) {
      return {
        ok: true,
        status: 200,
        data: { sessionId, context: { pressure: 0.4 }, tokens: { total: 1000 }, tools: { failures: state.failures, repeats: 0 } },
        error: null,
      }
    },
    supports() {
      return false
    },
  }
  const fish = {
    async overview() {
      return { ok: false, status: 401, data: null, error: 'HTTP 401' }
    },
    supports() {
      return false
    },
  }
  return { state, swarm, pressure, fish }
}

function testConfig(overrides = {}) {
  return resolveConfig({
    mode: 'guard',
    http: { token: 'test-token' },
    sampling: { swarmEventMs: 1_000, swarmSnapshotMs: 1_000, pressureMs: 1_000, fishMs: 1_000, requestTimeoutMs: 1_000 },
    policy: {
      twoSignalRule: false,
      throttleMinutes: 1,
      cooldownMs: 0,
      autopilot: { throttle: true, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true },
    },
    ...overrides,
  })
}

async function harness(ratio = 0, config = testConfig()) {
  const dir = tempDir()
  let now = Date.parse('2026-11-14T02:00:00.000Z')
  const ports = fakePorts(ratio)
  const supervisor = new RunSupervisor({
    runId: 'run-1',
    config,
    ports,
    dir,
    clock: () => now,
  })
  await supervisor.open()
  return {
    supervisor,
    ports,
    state: ports.state,
    dir,
    advance(ms) {
      now += ms
    },
    now,
  }
}

test('arm records a verifiable chain and samples the run', async () => {
  const { supervisor, ports, dir } = await harness(0)
  const result = await supervisor.arm({ mode: 'guard' })
  assert.equal(result.mode, 'guard')
  assert.equal(result.state, 'watching')
  const { events, chain } = readWatchLog(dir, 'run-1')
  assert.equal(chain.ok, true)
  assert.ok(events.some(event => event.type === 'watch/armed'))
  assert.equal(ports.state.calls.length, 0)
  await supervisor.disarm('test over')
  assert.equal(readWatchLog(dir, 'run-1').chain.ok, true)
})

test('budget pressure throttles once, then the throttle window resumes the run', async () => {
  const { supervisor, ports, advance, dir } = await harness(0.81)
  await supervisor.arm({ mode: 'guard' })
  // arm already ticked once: the L2 case and the throttle are immediate.
  assert.equal(ports.state.status, 'paused')
  assert.deepEqual(ports.state.calls.map(call => call.action), ['pause'])
  const [caseRecord] = supervisor.cases({ state: 'open' })
  assert.equal(caseRecord.code, 'budget_pressure')
  assert.equal(caseRecord.severity, 'L2')
  assert.equal(caseRecord.actions.at(-1).kind, 'throttle')
  assert.equal(caseRecord.actions.at(-1).state, 'verified')

  advance(61_000)
  await supervisor.tick()
  assert.deepEqual(ports.state.calls.map(call => call.action), ['pause', 'resume'])
  assert.equal(ports.state.status, 'running')
  assert.equal(supervisor.throttle, null)
  assert.equal(supervisor.cases({ state: 'all' })[0].state, 'closed')
  assert.equal(supervisor.cases({ state: 'all' })[0].closeReason, 'mitigated')
  assert.equal(readWatchLog(dir, 'run-1').chain.ok, true)
  await supervisor.disarm('test over')
})

test('95% pauses without an automatic resume and 100% aborts', async () => {
  const { supervisor, ports, state, advance } = await harness(0.96)
  await supervisor.arm({ mode: 'guard' })
  assert.equal(state.status, 'paused')
  assert.equal(state.calls.at(-1).action, 'pause')
  const pauseCase = supervisor.cases({ state: 'open' }).find(record => record.code === 'budget_pause')
  assert.ok(pauseCase)
  assert.equal(pauseCase.severity, 'L3')

  ports.state.spent = Math.round(LIMIT * 1.01)
  advance(1_000)
  await supervisor.tick()
  assert.equal(ports.state.status, 'aborted')
  assert.equal(ports.state.calls.at(-1).action, 'abort')
  const abortCase = supervisor.cases({ state: 'all' }).find(record => record.code === 'budget_exhausted')
  assert.ok(abortCase)
  assert.equal(abortCase.severity, 'L4')
  assert.equal(abortCase.state, 'closed')
  await supervisor.disarm('test over')
})

test('a member failure streak opens one L2 case without a guard action', async () => {
  const h = await harness(0.1)
  await h.supervisor.arm({ mode: 'guard' })
  h.ports.state.events = [{
    seq: 1,
    id: 'ev_1',
    type: 'swarm/dispatch/started',
    at: new Date(Date.parse('2026-11-14T02:00:00.000Z')).toISOString(),
    actor: 'system',
    payload: { memberId: 'mem_1', childId: 'sess-1', taskId: 'task_1' },
  }]
  h.ports.state.failures = 4
  h.advance(1_000)
  await h.supervisor.tick()
  const cases = h.supervisor.cases({ state: 'open' }).filter(record => record.code === 'failure_streak')
  assert.equal(cases.length, 1)
  assert.equal(cases[0].severity, 'L2')
  assert.equal(h.ports.state.calls.length, 0)

  h.advance(1_000)
  await h.supervisor.tick()
  assert.equal(h.supervisor.cases({ state: 'open' }).filter(record => record.code === 'failure_streak').length, 1)
  await h.supervisor.disarm('test over')
})

test('a missing write token downgrades the arm and the guard never acts', async () => {
  const config = testConfig({ http: { token: '' } })
  const { supervisor, ports } = await harness(0.97, config)
  const result = await supervisor.arm({ mode: 'guard' })
  assert.equal(result.mode, 'observe')
  assert.equal(ports.state.calls.length, 0)
  const notices = supervisor.store.read().filter(event => event.type === 'watch/guard/notice')
  assert.ok(notices.some(event => event.payload.code === 'write_disabled'))
  await supervisor.disarm('test over')
})

test('a second supervisor for the same run is refused by the lock', async () => {
  const first = await harness(0)
  await first.supervisor.arm({ mode: 'guard' })
  const second = new RunSupervisor({
    runId: 'run-1',
    config: testConfig(),
    ports: fakePorts(0),
    dir: first.dir,
    clock: Date.now,
    lockWaitMs: 50,
  })
  await assert.rejects(() => second.open(), error => error.code === 'ELOCKED')
  await first.supervisor.disarm('test over')
})
