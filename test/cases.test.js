import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { CaseManager, caseKey } from '../src/cases.js'
import { resolveConfig } from '../src/config.js'
import { budgetSignal } from '../src/signals.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-cases-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const config = resolveConfig({ policy: { twoSignalRule: true, cooldownMs: 60_000 } })

function fakeStore() {
  const events = []
  return {
    events,
    append(input) {
      events.push(input)
      return { ...input, seq: events.length }
    },
    read() {
      return events
    },
  }
}

function manager(options = {}) {
  const dir = tempDir()
  const store = fakeStore()
  const clock = options.clock ?? (() => Date.parse('2026-11-14T02:00:00.000Z'))
  const cases = new CaseManager({ runId: 'run-1', dir, store, config: options.config ?? config, clock })
  return { cases, store, dir }
}

function signal(overrides = {}) {
  const base = budgetSignal(
    { used: 810, limit: 1_000, scope: 'run', ref: { runId: 'run-1' }, at: '2026-11-14T02:00:00.000Z' },
    config.thresholds,
  )
  assert.ok(base)
  return { ...base, ...overrides, evidence: { ...base.evidence, ...(overrides.evidence ?? {}) } }
}

test('case keys are stable per run, code and scope', () => {
  const first = signal()
  assert.equal(caseKey('run-1', first), caseKey('run-1', first))
  assert.notEqual(caseKey('run-2', first), caseKey('run-1', first))
  const scoped = signal()
  scoped.evidence = { ...scoped.evidence, ref: { memberId: 'mem-2' } }
  assert.notEqual(caseKey('run-1', first), caseKey('run-1', scoped))
})

test('an L2 signal waits for the second consecutive tick before opening', () => {
  const { cases, store } = manager()
  const first = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  assert.equal(first.opened.length, 0)
  assert.equal(cases.list({ state: 'open' }).length, 0)

  const second = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:01.000Z') })
  assert.equal(second.opened.length, 1)
  assert.equal(second.opened[0].severity, 'L2')
  assert.ok(store.events.some(event => event.type === 'watch/case/opened'))
})

test('repeated evidence merges without duplicating signals, and escalation updates the same case', () => {
  const { cases, store } = manager({ config: resolveConfig({ policy: { twoSignalRule: false } }) })
  const opened = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  const record = opened.opened[0]
  assert.equal(record.signals.length, 1)

  const same = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:01.000Z') })
  assert.equal(same.updated.length, 0)
  assert.equal(cases.get(record.id).signals.length, 1)

  const escalatedSignal = signal({ severity: 'L3', summary: 'budget 96%' })
  const escalated = cases.reconcile({ signals: [escalatedSignal], snapshot: {}, now: Date.parse('2026-11-14T02:00:02.000Z') })
  assert.equal(escalated.updated.length, 1)
  assert.equal(cases.get(record.id).severity, 'L3')
  assert.ok(store.events.some(event => event.type === 'watch/case/updated' && event.payload.escalated === true))
})

test('a soft case resolves after its signal has been absent for resolveMs', () => {
  const { cases } = manager({ config: resolveConfig({ policy: { twoSignalRule: false, resolveMs: 1_000 } }) })
  const opened = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  assert.equal(opened.opened.length, 1)
  const result = cases.reconcile({
    signals: [],
    snapshot: { freshness: { swarm: { ok: true, stale: false } } },
    now: Date.parse('2026-11-14T02:00:02.000Z'),
  })
  assert.equal(result.closed.length, 1)
  assert.equal(result.closed[0].state, 'closed')
  assert.equal(result.closed[0].closeReason, 'resolved')
})

test('a source outage does not resolve a case', () => {
  const { cases } = manager({ config: resolveConfig({ policy: { twoSignalRule: false, resolveMs: 1_000 } }) })
  cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  const result = cases.reconcile({
    signals: [],
    snapshot: { freshness: { swarm: { ok: false, stale: true } } },
    now: Date.parse('2026-11-14T02:00:02.000Z'),
  })
  assert.equal(result.closed.length, 0)
  assert.equal(cases.openCount(), 1)
})

test('ack generation bump invalidates a late decision and closed cases reject actions', () => {
  const { cases } = manager({ config: resolveConfig({ policy: { twoSignalRule: false } }) })
  const record = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') }).opened[0]
  assert.equal(cases.bumpGeneration(record.id).generation, 2)
  cases.close(record.id, 'resolved', 'manual')
  assert.equal(cases.recordAction(record.id, { id: 'act_1', kind: 'coach' }), null)
  assert.equal(cases.recordDecision(record.id, { verdict: 'late' }), null)
})

test('a closed case suppresses the same severity inside the cooldown and reopens on escalation', () => {
  const { cases } = manager({ config: resolveConfig({ policy: { twoSignalRule: false, cooldownMs: 60_000 } }) })
  const first = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  const record = first.opened[0]
  cases.close(record.id, 'resolved', 'done in the test')

  const suppressed = cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:30.000Z') })
  assert.equal(suppressed.opened.length, 0)
  assert.equal(suppressed.suppressed, 1)

  const escalated = cases.reconcile({
    signals: [signal({ severity: 'L3', summary: 'budget 96%' })],
    snapshot: {},
    now: Date.parse('2026-11-14T02:00:31.000Z'),
  })
  assert.equal(escalated.opened.length, 1)
  assert.equal(escalated.opened[0].reopens, record.id)
  assert.equal(escalated.opened[0].generation, 2)
})

test('urgent cases bypass the open-case quota and closeAll abandons the rest', () => {
  const tight = resolveConfig({ policy: { twoSignalRule: false }, thresholds: { maxOpenCases: 1 } })
  const { cases, store } = manager({ config: tight })
  cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  const suppressed = cases.reconcile({
    signals: [signal({ code: 'failure_streak', severity: 'L2', evidence: { ...signal().evidence, id: 'ev-fail', ref: { taskId: 'task-1' } } })],
    snapshot: {},
    now: Date.parse('2026-11-14T02:00:01.000Z'),
  })
  assert.equal(suppressed.opened.length, 0)
  assert.ok(store.events.some(event => event.type === 'watch/case/suppressed'))

  const urgent = cases.ensure(signal({ code: 'budget_exhausted', severity: 'L4' }), Date.parse('2026-11-14T02:00:02.000Z'))
  assert.ok(urgent)
  assert.equal(cases.openCount(), 2)

  const closed = cases.closeAll('abandoned', 'plugin unloaded')
  assert.equal(closed.length, 2)
  assert.ok(closed.every(record => record.state === 'closed' && record.closeReason === 'abandoned'))
})

test('cases reload from the materialized view without losing actions', async () => {
  const { cases, dir } = manager({ config: resolveConfig({ policy: { twoSignalRule: false } }) })
  cases.reconcile({ signals: [signal()], snapshot: {}, now: Date.parse('2026-11-14T02:00:00.000Z') })
  const record = cases.list({ state: 'open' })[0]
  assert.ok(record)
  cases.recordAction(record.id, { id: 'act_1', kind: 'throttle', state: 'verified' })
  cases.setState(record.id, 'verifying')

  const store = fakeStore()
  const reloaded = new CaseManager({ runId: 'run-1', dir, store, config, clock: () => Date.parse('2026-11-14T02:00:10.000Z') })
  await reloaded.load()
  const again = reloaded.get(record.id)
  assert.equal(again.state, 'verifying')
  assert.equal(again.actions.length, 1)
  assert.equal(again.actions[0].state, 'verified')
})
