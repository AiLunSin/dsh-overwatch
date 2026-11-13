import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { Probe } from '../src/probe.js'

const config = resolveConfig({
  sampling: { swarmEventMs: 1_000, swarmSnapshotMs: 2_000, pressureMs: 1_000, fishMs: 5_000, requestTimeoutMs: 1_000 },
})

const T0 = Date.parse('2026-11-14T02:00:00.000Z')

function event(seq, type, payload = {}) {
  return { seq, id: `ev_${seq}`, type, at: new Date(T0 + seq * 100).toISOString(), actor: 'system', payload }
}

function fakePorts(options = {}) {
  const state = {
    events: options.events ?? [event(1, 'swarm/dispatch/started', { memberId: 'mem-1', childId: 'sess-1', taskId: 'task-1' })],
    snapshots: options.snapshots ?? 0,
    snapshotFails: options.snapshotFails ?? 0,
    pressureRatio: options.pressureRatio ?? 0.82,
    fishOk: options.fishOk ?? false,
  }
  return {
    state,
    swarm: {
      async events(_runId, query = {}) {
        const since = query.since ?? 0
        return { ok: true, status: 200, data: { events: state.events.filter(entry => entry.seq > since) }, error: null }
      },
      async run() {
        if (state.snapshotFails > 0) {
          state.snapshotFails -= 1
          return { ok: false, status: 503, data: null, error: 'HTTP 503' }
        }
        state.snapshots += 1
        return {
          ok: true,
          status: 200,
          data: {
            swarmId: 'run-1',
            runId: 'run-1',
            goal: 'test',
            status: 'running',
            round: 2,
            createdAt: T0,
            updatedAt: T0 + 1_000,
            budget: {
              limits: { runTokens: 2_000, runUsd: 0, runWallMs: 0, taskTokens: 500, memberTokens: 800 },
              run: { tokens: 1_600, reservedTokens: 100, calls: 4, usd: 0, reservedUsd: 0, wallMs: 0 },
              tasks: {},
              members: {},
              reservations: 2,
            },
            members: [
              { id: 'mem-1', name: 'worker-1', role: 'worker', status: 'busy', load: 1 },
              { id: 'mem-q', name: 'queen', role: 'queen', status: 'idle', load: 0 },
            ],
            tasks: [
              { id: 't1', state: 'working' },
              { id: 't2', state: 'queued' },
              { id: 't3', state: 'reviewing' },
              { id: 't4', state: 'merged' },
              { id: 't5', state: 'failed' },
            ],
            workspace: { conflicts: 2 },
            dispatch: { auto: true, active: 1 },
          },
          error: null,
        }
      },
    },
    pressure: {
      async live(sessionId) {
        if (options.pressureOk === false) return { ok: false, status: 404, data: null, error: 'HTTP 404' }
        return { ok: true, status: 200, data: { sessionId, context: { pressure: state.pressureRatio }, tokens: { total: 5_000 } }, error: null }
      },
    },
    fish: {
      async overview() {
        return state.fishOk
          ? { ok: true, status: 200, data: { sources: [1], checkpoints: [1, 2] }, error: null }
          : { ok: false, status: 401, data: null, error: 'HTTP 401' }
      },
    },
  }
}

test('prime normalizes the swarm snapshot and attaches pressure by child session', async () => {
  const ports = fakePorts()
  const probe = new Probe({ ports, config, clock: () => T0 + 1_000 })
  const primed = await probe.prime('run-1')
  assert.equal(primed.ok, true)
  const snapshot = probe.snapshot('run-1')
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.round, 2)
  assert.equal(snapshot.budget.limit, 2_000)
  assert.equal(snapshot.budget.spent, 1_700)
  assert.equal(snapshot.budget.ratio, 0.85)
  assert.deepEqual(snapshot.tasks, { queued: 1, working: 1, reviewing: 1, approved: 0, blocked: 0, merged: 1, failed: 1, total: 5 })
  assert.equal(snapshot.members[0].childId, 'sess-1')
  assert.equal(snapshot.members[0].context, 0.82)
  assert.equal(probe.freshness('run-1').pressure.ok, true)
  assert.equal(probe.freshness('run-1').fish.ok, false)
})

test('a sequence gap is latched and the stream is rebuilt once', async () => {
  const ports = fakePorts({ events: [event(1, 'swarm/status/changed', { from: 'created', to: 'running' })] })
  const probe = new Probe({ ports, config, clock: () => T0 })
  await probe.prime('run-1')
  assert.equal(probe.snapshot('run-1').eventGap, null)

  ports.state.events = [
    event(1, 'swarm/status/changed', { from: 'created', to: 'running' }),
    event(3, 'swarm/member/joined', { memberId: 'mem-1' }),
  ]
  const ticked = await probe.tick('run-1', T0 + 1_000)
  assert.deepEqual(ticked.snapshot.eventGap, {
    expectedSeq: 2,
    actualSeq: 3,
    at: new Date(T0 + 1_000).toISOString(),
  })
  // The rebuild re-reads from zero, so the timeline itself has no hole.
  assert.deepEqual(probe.events('run-1', { since: 0 }).map(entry => entry.seq), [1, 3])
})

test('a failed snapshot marks freshness false and backs off instead of reporting zeros', async () => {
  const ports = fakePorts({ snapshotFails: 1 })
  const probe = new Probe({ ports, config, clock: () => T0 })
  const primed = await probe.prime('run-1')
  assert.equal(primed.ok, false)
  const freshness = probe.freshness('run-1')
  assert.equal(freshness.swarm.ok, false)
  assert.match(freshness.swarm.error, /503/)

  const retried = await probe.tick('run-1', T0 + 4_000)
  assert.equal(retried.snapshot.status, 'running')
  assert.equal(probe.freshness('run-1').swarm.ok, true)
})

test('a missing pressure service does not poison swarm freshness', async () => {
  const ports = fakePorts({ pressureOk: false })
  const probe = new Probe({ ports, config, clock: () => T0 })
  const primed = await probe.prime('run-1')
  assert.equal(primed.ok, true)
  const freshness = probe.freshness('run-1')
  assert.equal(freshness.swarm.ok, true)
  assert.equal(freshness.pressure.ok, false)
  assert.match(freshness.pressure.error, /404/)
})

test('event batches advance a single cursor and keep summaries bounded', async () => {
  const longReason = 'x'.repeat(1_000)
  const ports = fakePorts({
    events: [
      event(1, 'swarm/status/changed', { from: 'created', to: 'running' }),
      event(2, 'swarm/aborted', { reason: longReason }),
    ],
  })
  const probe = new Probe({ ports, config, clock: () => T0 })
  await probe.prime('run-1')
  const events = probe.events('run-1')
  assert.equal(events.length, 2)
  assert.ok(events[1].summary.length < 300)
  assert.equal(probe.snapshot('run-1').lastEventSeq, 2)
})
