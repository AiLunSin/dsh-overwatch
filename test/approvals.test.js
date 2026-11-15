import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { ApprovalQueue } from '../src/approvals.js'
import { authorizeHumanDecision, authorizeHumanPlan } from '../src/policy.js'
import { WatchStore } from '../src/store.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-approvals-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function decision(action = 'pause') {
  return {
    caseId: 'case-1',
    action,
    target: { kind: 'swarm_run', id: 'run-1' },
    params: { mode: 'pause' },
    reason: 'budget pressure',
    evidenceRefs: [],
    confidence: 0.9,
    expectedEffect: 'pause the run',
  }
}

async function fixture(options = {}) {
  let now = Date.parse('2026-11-15T00:00:00.000Z')
  const clock = () => now
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-1', clock, lockWaitMs: 10 })
  await store.open()
  const queue = new ApprovalQueue({
    dir: path.join(dir, 'approvals'),
    runId: 'run-1',
    store,
    clock,
    ttlMs: options.ttlMs ?? 60_000,
    challengeTtlMs: options.challengeTtlMs ?? 10_000,
  })
  queue.load()
  return {
    dir,
    store,
    queue,
    advance: (ms) => { now += ms },
    close: () => store.close(),
  }
}

test('a repeated tick reuses the pending approval instead of flooding the queue', async () => {
  const fx = await fixture()
  const first = fx.queue.request({
    kind: 'decision',
    key: 'case-1:pause',
    caseId: 'case-1',
    action: 'pause',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: {},
    reason: 'budget pressure',
    request: { decision: decision() },
  })
  const second = fx.queue.request({
    kind: 'decision',
    key: 'case-1:pause',
    caseId: 'case-1',
    action: 'pause',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: {},
    reason: 'budget pressure',
    request: { decision: decision() },
  })
  assert.equal(first.existing, false)
  assert.equal(second.existing, true)
  assert.equal(first.approval.id, second.approval.id)
  assert.equal(fx.queue.list({ state: 'pending' }).length, 1)
  fx.close()
})

test('a one-time challenge token approves exactly once and is never stored in plaintext', async () => {
  const fx = await fixture()
  const queued = fx.queue.request({
    kind: 'decision',
    key: 'case-1:pause',
    caseId: 'case-1',
    action: 'pause',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: {},
    reason: 'budget pressure',
    request: { decision: decision() },
  }).approval
  const challenge = fx.queue.challenge(queued.id)
  assert.match(challenge.token, /^[A-Za-z0-9_-]{20,}$/)
  const onDisk = readFileSync(path.join(fx.dir, 'approvals', `${queued.id}.json`), 'utf8')
  assert.equal(onDisk.includes(challenge.token), false, 'only the token hash may be persisted')

  assert.throws(() => fx.queue.approve(queued.id, 'not-the-token'), error => error.code === 'APPROVAL_TOKEN_INVALID')
  const approved = fx.queue.approve(queued.id, challenge.token, 'looks safe')
  assert.equal(approved.status, 'approved')
  assert.equal(fx.queue.complete(queued.id, 'executed', { ok: true, actionId: 'act_1' }).status, 'executed')
  assert.throws(() => fx.queue.approve(queued.id, challenge.token), error => error.code === 'APPROVAL_CONFLICT')
  fx.close()
})

test('pending approvals expire, can be rejected, and survive a reload', async () => {
  const fx = await fixture({ ttlMs: 1_000 })
  const first = fx.queue.request({
    kind: 'guard_plan',
    key: 'case-1:pause:run-1',
    caseId: 'case-1',
    severity: 'L3',
    action: 'pause',
    reason: 'hard pause',
    request: { plan: { caseId: 'case-1', kind: 'pause', severity: 'L3', reason: 'hard pause', evidenceRefs: [], params: {} } },
  }).approval
  const reloaded = new ApprovalQueue({
    dir: path.join(fx.dir, 'approvals'),
    runId: 'run-1',
    store: fx.store,
    clock: () => Date.parse('2026-11-15T00:00:00.000Z'),
  })
  reloaded.load()
  assert.equal(reloaded.get(first.id).status, 'pending')

  fx.advance(2_000)
  assert.equal(fx.queue.expire(), 1)
  assert.equal(fx.queue.get(first.id).status, 'expired')
  assert.throws(() => fx.queue.challenge(first.id), error => error.code === 'APPROVAL_CONFLICT')

  const second = fx.queue.request({
    kind: 'decision',
    key: 'case-2:abort',
    caseId: 'case-2',
    action: 'abort',
    reason: 'runaway',
    request: { decision: { ...decision('abort'), caseId: 'case-2' } },
  }).approval
  const rejected = fx.queue.reject(second.id, 'not yet')
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectionReason, 'not yet')
  fx.close()
})

test('human approval never overrides observe mode, and guard mode keeps model decisions closed', () => {
  assert.equal(authorizeHumanDecision(decision(), { mode: 'observe' }).allowed, false)
  assert.equal(authorizeHumanDecision(decision(), { mode: 'guard' }).allowed, false)
  assert.equal(authorizeHumanDecision(decision(), { mode: 'supervised' }).allowed, true)
  const plan = { caseId: 'case-1', kind: 'pause', severity: 'L3', target: { kind: 'swarm_run', id: 'run-1' }, reason: 'x', evidenceRefs: [], params: {} }
  assert.equal(authorizeHumanPlan(plan, { mode: 'observe' }).allowed, false)
  assert.equal(authorizeHumanPlan(plan, { mode: 'guard' }).allowed, true)
})
