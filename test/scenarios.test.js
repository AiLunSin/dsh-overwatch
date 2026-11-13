import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { RunSupervisor } from '../src/run.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-scenario-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const LIMIT = 1_000_000
const T0 = Date.parse('2026-11-14T02:00:00.000Z')

function baseConfig(overrides = {}) {
  return resolveConfig({
    mode: 'guard',
    http: { token: 'test-token' },
    sampling: { swarmEventMs: 1_000, swarmSnapshotMs: 1_000, pressureMs: 1_000, fishMs: 1_000, requestTimeoutMs: 1_000 },
    policy: {
      twoSignalRule: false,
      cooldownMs: 0,
      throttleMinutes: 1,
      autopilot: { throttle: false, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true },
    },
    thresholds: {
      stallMs: 600_000,
      reviewDeadlockMs: 900_000,
      gateFailures: 3,
      conflictStorm: 3,
      ...overrides.thresholds,
    },
    ...overrides,
  })
}

/**
 * One fake swarm + pressure fixture. `mount()` returns a supervisor armed at
 * `ratio`; scenarios then inject events and advance the fake clock.
 */
function fixture(options = {}) {
  const state = {
    status: 'running',
    spent: Math.round(LIMIT * (options.ratio ?? 0.1)),
    events: [],
    failures: options.failures ?? 0,
    context: options.context ?? 0.4,
    updatedAt: options.updatedAt ?? T0,
    calls: [],
  }
  const swarm = {
    async health() {
      return { ok: true, status: 200, data: { ok: true }, error: null }
    },
    async run() {
      return {
        ok: true,
        status: 200,
        data: {
          runId: 'run-1',
          goal: 'scenario',
          status: state.status,
          round: 1,
          createdAt: T0,
          updatedAt: state.updatedAt,
          budget: {
            limits: { runTokens: LIMIT, runUsd: 0, runWallMs: 0, taskTokens: 1, memberTokens: 1 },
            run: { tokens: state.spent, reservedTokens: 0, calls: 1, usd: 0, reservedUsd: 0, wallMs: 0 },
            tasks: {},
            members: {},
            reservations: 0,
          },
          members: [
            { id: 'mem_queen', name: 'queen', role: 'queen', status: 'idle' },
            { id: 'mem_1', name: 'worker-1', role: 'worker', status: 'busy' },
          ],
          tasks: [],
          reviews: [],
          workspace: { conflicts: 0 },
          dispatch: { auto: false, active: 0 },
        },
        error: null,
      }
    },
    async events(_runId, query = {}) {
      const since = query.since ?? 0
      return { ok: true, status: 200, data: { events: state.events.filter(event => event.seq > since) }, error: null }
    },
    async intervene(_runId, body) {
      state.calls.push({ action: body.action, reason: body.reason })
      if (body.action === 'pause') state.status = 'paused'
      if (body.action === 'abort') state.status = 'aborted'
      return { ok: true, status: 200, data: { status: state.status }, error: null }
    },
    supports(decision) {
      return decision.target.kind === 'swarm_run'
    },
    async apply(decision, context) {
      await swarm.intervene('run-1', { action: decision.action === 'throttle' ? 'pause' : decision.action, reason: decision.reason })
      return { ok: true, httpStatus: 200, actionId: context.actionId }
    },
    async verify(decision) {
      const expected = decision.action === 'abort' ? 'aborted' : decision.action === 'resume' ? 'running' : 'paused'
      return { ok: state.status === expected, detail: { status: state.status } }
    },
  }
  const pressure = {
    async live(sessionId) {
      return {
        ok: true,
        status: 200,
        data: { sessionId, context: { pressure: state.context }, tokens: { total: 1000 }, tools: { failures: state.failures, repeats: 0 } },
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

  let now = T0
  function advance(ms) {
    now += ms
  }
  async function mount(config) {
    const supervisor = new RunSupervisor({
      runId: 'run-1',
      config,
      ports: { swarm, pressure, fish },
      dir: tempDir(),
      clock: () => now,
      ctx: { get: () => undefined },
    })
    await supervisor.open()
    await supervisor.arm({ mode: 'guard' })
    return supervisor
  }
  return { state, mount, advance, now: () => now }
}

/** @param {RunSupervisor} supervisor */
function caseCodes(supervisor) {
  return supervisor.cases({ state: 'all' }).map(record => `${record.code}:${record.severity}`)
}

/** @param {RunSupervisor} supervisor */
function openCodes(supervisor) {
  return supervisor.cases({ state: 'open' }).map(record => `${record.code}:${record.severity}`)
}

test('I-1 budget cliff: throttle/pause before 100%, abort at 100%', async () => {
  const f = fixture({ ratio: 0.96 })
  const supervisor = await f.mount(baseConfig())
  assert.equal(f.state.status, 'paused')
  assert.ok(f.state.calls.some(call => call.action === 'pause'))
  assert.ok(openCodes(supervisor).includes('budget_pause:L3'))
  f.state.spent = Math.round(LIMIT * 1.001)
  f.advance(1_000)
  await supervisor.tick()
  assert.equal(f.state.status, 'aborted')
  assert.ok(f.state.calls.some(call => call.action === 'abort'))
  assert.ok(caseCodes(supervisor).includes('budget_exhausted:L4'))
  assert.equal(supervisor.store.verify().ok, true)
  await supervisor.disarm('scenario done')
})

test('I-2 context explosion opens an L2 case without killing the run', async () => {
  const f = fixture({ ratio: 0.2, context: 0.96 })
  const supervisor = await f.mount(baseConfig())
  f.state.events = [event(1, 'swarm/dispatch/started', { memberId: 'mem_1', childId: 'sess-1' })]
  f.advance(1_000)
  await supervisor.tick()
  assert.ok(openCodes(supervisor).includes('context_pressure:L2'))
  assert.equal(f.state.status, 'running')
  assert.equal(f.state.calls.filter(call => call.action === 'abort').length, 0)
  await supervisor.disarm('scenario done')
})

test('I-3 failure loop opens an L2 case and does not abort', async () => {
  const f = fixture({ ratio: 0.2, failures: 4 })
  const supervisor = await f.mount(baseConfig())
  f.state.events = [event(1, 'swarm/dispatch/started', { memberId: 'mem_1', childId: 'sess-1' })]
  f.advance(1_000)
  await supervisor.tick()
  assert.ok(openCodes(supervisor).includes('failure_streak:L2'))
  assert.equal(f.state.status, 'running')
  await supervisor.disarm('scenario done')
})

test('I-4 silent member opens a stalled_dispatch case', async () => {
  const f = fixture({ ratio: 0.2, updatedAt: T0 - 3_600_000 })
  const supervisor = await f.mount(baseConfig({ thresholds: { stallMs: 1_000 } }))
  assert.ok(openCodes(supervisor).includes('stalled_dispatch:L2'))
  assert.equal(f.state.calls.length, 0)
  await supervisor.disarm('scenario done')
})

test('I-5 review deadlock opens an L2 case after the window', async () => {
  const f = fixture({ ratio: 0.2 })
  const supervisor = await f.mount(baseConfig({ thresholds: { reviewDeadlockMs: 1_000 } }))
  f.state.events = [event(1, 'swarm/review/opened', { taskId: 'task-1', patchId: 'patch-1', reviewers: ['mem_1', 'mem_2'] })]
  f.advance(2_000)
  await supervisor.tick()
  assert.ok(openCodes(supervisor).includes('review_deadlock:L2'))
  await supervisor.disarm('scenario done')
})

test('I-6 gate ping-pong opens an L2 case at three failures', async () => {
  const f = fixture({ ratio: 0.2 })
  const supervisor = await f.mount(baseConfig())
  f.state.events = [1, 2, 3].map(seq => event(seq, 'swarm/task/gate', { taskId: 'task-1', scope: 'patch', gate: { passed: false } }))
  f.advance(1_000)
  await supervisor.tick()
  assert.ok(openCodes(supervisor).includes('gate_pingpong:L2'))
  await supervisor.disarm('scenario done')
})

test('I-7 conflict storm opens an L2 case', async () => {
  const f = fixture({ ratio: 0.2 })
  const supervisor = await f.mount(baseConfig())
  f.state.events = [1, 2, 3].map(seq => event(seq, 'swarm/merge/conflict', { taskId: `task-${seq}`, files: ['src/app.js'] }))
  f.advance(1_000)
  await supervisor.tick()
  assert.ok(openCodes(supervisor).includes('conflict_storm:L2'))
  await supervisor.disarm('scenario done')
})

test('I-8 event stream gap aborts and marks the log integrity case', async () => {
  const f = fixture({ ratio: 0.2 })
  const supervisor = await f.mount(baseConfig())
  f.state.events = [event(1, 'swarm/status/changed', { from: 'running', to: 'running' }), event(3, 'swarm/task/working', { taskId: 'task-1' })]
  f.advance(1_000)
  await supervisor.tick()
  assert.equal(f.state.status, 'aborted')
  assert.ok(f.state.calls.some(call => call.action === 'abort'))
  assert.ok(caseCodes(supervisor).includes('log_integrity:L4'))
  assert.equal(supervisor.store.verify().ok, true)
  await supervisor.disarm('scenario done')
})

/** @param {number} seq @param {string} type @param {Record<string, unknown>} payload */
function event(seq, type, payload) {
  return { seq, id: `ev_${seq}`, type, at: new Date(T0).toISOString(), actor: 'system', payload }
}
