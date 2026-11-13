import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { CaseManager } from '../src/cases.js'
import { resolveConfig } from '../src/config.js'
import { evaluateGuard } from '../src/guard.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-guard-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-11-14T02:00:00.000Z')

function config(overrides = {}) {
  return resolveConfig({
    policy: {
      twoSignalRule: false,
      throttleMinutes: 10,
      cooldownMs: 900_000,
      autopilot: { throttle: true, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true },
    },
    http: { token: 'test-token' },
    ...overrides,
  })
}

function store() {
  const events = []
  return { events, append(input) { events.push(input) } }
}

function harness(cfg = config()) {
  const events = store()
  const cases = new CaseManager({ runId: 'run-1', dir: tempDir(), store: events, config: cfg, clock: () => NOW })
  return {
    cases,
    events,
    state: { interventions: 0, throttle: null, lastActions: new Map() },
    run(ratio, status = 'running', gap = null) {
      return {
        snapshot: {
          status,
          asOf: new Date(NOW).toISOString(),
          budget: { limit: 1_000, spent: Math.round(1_000 * ratio), ratio },
          eventGap: gap,
          lastEventAt: new Date(NOW).toISOString(),
        },
        cases,
        state: this.state,
        config: cfg,
        runId: 'run-1',
        now: NOW,
      }
    },
  }
}

test('budget pressure plans a bounded throttle with case evidence', () => {
  const h = harness()
  const result = evaluateGuard(h.run(0.81))
  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0].kind, 'throttle')
  assert.equal(result.plans[0].severity, 'L2')
  assert.equal(result.plans[0].params.minutes, 10)
  assert.ok(result.plans[0].evidenceRefs.length >= 1)
  assert.equal(h.cases.openCount(), 1)
})

test('the hard pause and abort thresholds are marked as hard limits', () => {
  const pause = evaluateGuard(harness().run(0.96))
  assert.equal(pause.plans[0].kind, 'pause')
  assert.equal(pause.plans[0].severity, 'L3')
  assert.equal(pause.plans[0].hardLimit, true)

  const abortHarness = harness()
  const abort = evaluateGuard(abortHarness.run(1.0))
  assert.equal(abort.plans[0].kind, 'abort')
  assert.equal(abort.plans[0].severity, 'L4')
  assert.equal(abort.plans[0].hardLimit, true)
})

test('a sequence gap arms the abort and keeps the integrity case', () => {
  const h = harness()
  const result = evaluateGuard(h.run(0.2, 'running', { expectedSeq: 12, actualSeq: 15, at: new Date(NOW).toISOString() }))
  assert.equal(result.plans[0].kind, 'abort')
  assert.equal(result.plans[0].severity, 'L4')
  const record = h.cases.list({ state: 'open' })[0]
  assert.equal(record.code, 'log_integrity')
})

test('an empty write token blocks every action but still records the notice', () => {
  const h = harness(config({ http: { token: '' } }))
  const result = evaluateGuard(h.run(0.96))
  assert.equal(result.plans.length, 0)
  assert.ok(result.notices.some(notice => notice.code === 'write_disabled'))
})

test('the auto intervention limit stops soft actions but never the abort', () => {
  const h = harness()
  h.state.interventions = 5
  const throttled = evaluateGuard(h.run(0.81))
  assert.equal(throttled.plans.length, 0)
  assert.ok(throttled.notices.some(notice => notice.code === 'auto_intervention_limit'))
  const aborted = evaluateGuard(h.run(1.0))
  assert.equal(aborted.plans[0].kind, 'abort')
})

test('a run that is already paused does not get a second pause', () => {
  const h = harness()
  const result = evaluateGuard(h.run(0.96, 'paused'))
  assert.equal(result.plans.length, 0)
  assert.ok(result.notices.some(notice => notice.code === 'hard_pause_skipped'))
})

test('an elapsed throttle window plans an automatic resume against the same case', () => {
  const h = harness()
  const first = evaluateGuard(h.run(0.81))
  const caseId = first.plans[0].caseId
  h.state.throttle = { active: true, actionId: 'act_1', caseId, dueAt: NOW - 1, minutes: 1 }
  const result = evaluateGuard(h.run(0.81, 'paused'))
  const resume = result.plans.find(plan => plan.kind === 'resume')
  assert.ok(resume)
  assert.equal(resume.params.ofActionId, 'act_1')
  assert.equal(resume.params.automatic, true)
  assert.ok(resume.evidenceRefs.length >= 1)
})

test('a recent attempt for the same case is suppressed by the cooldown', () => {
  const h = harness()
  const first = evaluateGuard(h.run(0.81))
  h.state.lastActions.set(`${first.plans[0].caseId}:throttle`, NOW - 1_000)
  const second = evaluateGuard(h.run(0.81))
  assert.equal(second.plans.length, 0)
  assert.ok(second.notices.some(notice => notice.code === 'cooldown'))
})
