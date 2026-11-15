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
          createdAt: Date.parse('2026-11-14T02:00:00.000Z'),
          updatedAt: Date.parse('2026-11-14T02:00:00.500Z'),
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

async function harness(ratio = 0, config = testConfig(), extra = {}) {
  const dir = tempDir()
  let now = Date.parse('2026-11-14T02:00:00.000Z')
  const ports = fakePorts(ratio)
  const supervisor = new RunSupervisor({
    runId: 'run-1',
    config,
    ports,
    dir,
    clock: () => now,
    ctx: extra.ctx,
    watchFactory: extra.watchFactory,
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

function fakeSubagents(capacity = 8) {
  return {
    config: { maxActiveSubagents: { get: () => capacity } },
    namesOf: agent => ({ self: String(agent?.id ?? ''), parent: 'lead' }),
  }
}

function fakeWatch(behaviour = 'decided') {
  const calls = []
  const watch = {
    name: 'ow-test',
    childId: null,
    pending: null,
    wakes: 0,
    timeouts: 0,
    calls,
    handleAgentCreated() {
      return false
    },
    status() {
      return { state: 'idle', name: this.name, childId: this.childId, wakes: this.wakes, timeouts: this.timeouts, errors: 0 }
    },
    async wake(input) {
      calls.push({ ...input, stack: new Error().stack })
      this.wakes += 1
      if (behaviour === 'timeout') {
        this.timeouts += 1
        return { status: 'timeout' }
      }
      return {
        status: 'decided',
        decision: { action: 'coach', reason: 'watch officer coached the stalled member', confidence: 0.8 },
        outcome: { ok: true, actionId: 'act_watch_1', verified: true },
      }
    },
    async dispose() {},
  }
  return watch
}

test('supervised arm requires the live root agent and a real capacity check', async () => {
  const config = testConfig({ http: { token: 'test-token' } })
  const noAgent = await harness(0.1, config)
  await assert.rejects(() => noAgent.supervisor.arm({ mode: 'supervised' }), error => error.code === 'AGENT_REQUIRED')
  await noAgent.supervisor.disarm('test over')

  const tight = await harness(0.1, config, { ctx: { get: name => (name === 'subagents' ? fakeSubagents(1) : undefined) } })
  await assert.rejects(
    () => tight.supervisor.arm({ mode: 'supervised', parentAgent: { id: 'root' } }),
    error => error.code === 'CAPACITY_CONFLICT',
  )
  await tight.supervisor.disarm('test over')
})

test('a supervised run wakes the officer on an L2 case and applies its decision', async () => {
  const config = testConfig({ policy: { twoSignalRule: false, cooldownMs: 0, autopilot: { throttle: false, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true } } })
  const watch = fakeWatch('decided')
  const { supervisor } = await harness(0.81, config, {
    ctx: { get: name => (name === 'subagents' ? fakeSubagents(8) : undefined) },
    watchFactory: () => watch,
  })
  const armed = await supervisor.arm({ mode: 'supervised', parentAgent: { id: 'root' } })
  assert.equal(armed.mode, 'supervised')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(watch.calls.length, 1)
  assert.match(watch.calls[0].card.caseId, /^case_/)
  const caseId = watch.calls[0].caseId
  assert.match(caseId, /^case_/)
  const view = supervisor.snapshot()
  assert.equal(view.watch.enabled, true)
  assert.equal(view.watch.wakes, 1)
  assert.equal(view.watch.reserve > 0, true)
  const closed = supervisor.cases({ state: 'all' }).find(record => record.id === caseId)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.closeReason, 'mitigated')
  assert.ok(supervisor.store.read().some(event => event.type === 'watch/decision' && event.payload.action === 'coach'))
  await supervisor.disarm('test over')
})

test('an L3 supervised pause is queued, then approved and executed exactly once', async () => {
  const { supervisor, state } = await harness(0.81, testConfig(), {
    ctx: { get: name => (name === 'subagents' ? fakeSubagents(8) : undefined) },
  })
  await supervisor.arm({ mode: 'supervised', parentAgent: { id: 'root' } })
  const record = supervisor.caseManager.list({ state: 'open' })[0]
  assert.ok(record, 'the pressure case must be open')
  const evidenceIds = new Set(record.evidence.map(entry => String(entry.id)))
  const queued = await supervisor.executor.execute({
    schemaVersion: 1,
    caseId: record.id,
    action: 'pause',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: { mode: 'pause', runId: 'run-1' },
    evidenceRefs: [String(record.evidence[0].id)],
    reason: 'a human should decide this pause',
    confidence: 0.9,
  }, { caseId: record.id, evidenceIds, hardLimit: false, runId: 'run-1' })
  assert.equal(queued.code, 'APPROVAL_REQUIRED')
  const pending = supervisor.approvals({ state: 'pending' })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].action, 'pause')
  // The queued pause is not applied: the call count stays where the guard's own
  // throttle left it until a human approves.
  const callsBeforeApproval = state.calls.length
  assert.equal(supervisor.snapshot().approvals.pending, 1)
  assert.ok(supervisor.store.read().some(event => event.type === 'watch/approval/requested'))

  const challenge = supervisor.challengeApproval(pending[0].id)
  await assert.rejects(() => supervisor.approveApproval(pending[0].id, 'wrong-token'), error => error.code === 'APPROVAL_TOKEN_INVALID')
  await supervisor.approveApproval(pending[0].id, challenge.token, 'approved in a test')
  assert.equal(state.status, 'paused')
  assert.equal(state.calls.length, callsBeforeApproval + 1)
  assert.equal(state.calls.at(-1).action, 'pause')
  assert.equal(supervisor.approvalDetail(pending[0].id).status, 'executed')
  assert.throws(() => supervisor.challengeApproval(pending[0].id), error => error.code === 'APPROVAL_CONFLICT')
  assert.ok(supervisor.store.read().some(event => event.type === 'watch/approval/executed'))
  assert.equal(supervisor.snapshot().approvals.pending, 0)
  assert.equal(supervisor.store.verify().ok, true)
  await supervisor.disarm('test over')
})

test('a watch timeout is recorded, the case stays open, and the guard remains in charge', async () => {
  const config = testConfig({ policy: { twoSignalRule: false, cooldownMs: 0, autopilot: { throttle: false, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true } } })
  const watch = fakeWatch('timeout')
  const { supervisor } = await harness(0.81, config, {
    ctx: { get: name => (name === 'subagents' ? fakeSubagents(8) : undefined) },
    watchFactory: () => watch,
  })
  await supervisor.arm({ mode: 'supervised', parentAgent: { id: 'root' } })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(supervisor.store.read().some(event => event.type === 'watch/wake/timeout'))
  const record = supervisor.cases({ state: 'all' }).find(candidate => candidate.code === 'budget_pressure')
  assert.equal(record.state, 'open')
  assert.ok(record.decisions.some(decision => decision.verdict === 'timeout'))
  await supervisor.disarm('test over')
  const shift = supervisor.lastShift
  assert.ok(shift !== null)
  assert.match(shift.id, /^shift-/)
})

test('a wall-clock jump is recorded and does not fabricate a stall', async () => {
  const h = await harness(0.1)
  await h.supervisor.arm({ mode: 'guard' })
  h.advance(90 * 60_000)
  await h.supervisor.tick()
  assert.ok(h.supervisor.store.read().some(event => event.type === 'watch/clock/jump'))
  assert.equal(h.supervisor.cases({ state: 'open' }).filter(record => record.code === 'stalled_dispatch').length, 0)
  assert.equal(h.supervisor.store.verify().ok, true)
  await h.supervisor.disarm('test over')
})

test('the merged timeline includes swarm, pressure and watch with an opaque cursor', async () => {
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
  h.advance(1_000)
  await h.supervisor.tick()

  const first = h.supervisor.timeline({ since: 0, limit: 100 })
  const sources = new Set(first.events.map(event => event.source))
  assert.ok(sources.has('swarm'))
  assert.ok(sources.has('pressure'))
  assert.ok(sources.has('watch'))
  assert.equal(typeof first.nextSince, 'string')
  const ats = first.events.map(event => event.at)
  assert.deepEqual(ats, [...ats].sort())

  const page = h.supervisor.timeline({ since: 0, limit: 2 })
  assert.equal(page.events.length, 2)
  const next = h.supervisor.timeline({ since: page.nextSince, limit: 2 })
  assert.ok(next.events.length > 0)
  assert.notEqual(next.events[0].at + next.events[0].type, page.events[0].at + page.events[0].type)
  await h.supervisor.disarm('test over')
})

test('restore intent/result are recorded, and the confirm token is refused', async () => {
  const h = await harness(0.1)
  await h.supervisor.arm({ mode: 'guard' })
  const intent = h.supervisor.recordRestore({
    phase: 'intent',
    sourceId: 'fish-a',
    checkpointId: 'ck_1',
    files: [{ path: 'a.md', action: 'restore', stale: false, bytes: 10 }],
    warnings: ['a.md changed after the checkpoint'],
  })
  assert.equal(intent.recorded, true)
  const result = h.supervisor.recordRestore({
    phase: 'result',
    sourceId: 'fish-a',
    checkpointId: 'ck_1',
    result: { ok: true, files: [{ path: 'a.md', ok: true, sha256: 'a'.repeat(64) }] },
  })
  assert.equal(result.phase, 'result')
  const events = h.supervisor.store.read()
  assert.ok(events.some(event => event.type === 'watch/restore/intent' && event.payload.sourceId === 'fish-a'))
  assert.ok(events.some(event => event.type === 'watch/restore/result' && event.payload.result.ok === true))

  assert.throws(
    () => h.supervisor.recordRestore({ phase: 'intent', sourceId: 'fish-a', checkpointId: 'ck_1', confirmToken: 'secret' }),
    error => error.code === 'RESTORE_TOKEN_REJECTED',
  )
  assert.throws(
    () => h.supervisor.recordRestore({ phase: 'intent', sourceId: 'fish-a', checkpointId: 'ck_1', result: { nested: { confirmToken: 'x' } } }),
    error => error.code === 'RESTORE_TOKEN_REJECTED',
  )
  assert.throws(
    () => h.supervisor.recordRestore({ phase: 'later', sourceId: 'fish-a', checkpointId: 'ck_1' }),
    error => error.code === 'INVALID_PHASE',
  )
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
