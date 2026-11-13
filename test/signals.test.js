import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetSignal, evaluateSnapshot, failureStreakSignal, stallSignal } from '../src/signals.js'

const thresholds = {
  budgetPressure: 0.8,
  budgetPause: 0.95,
  failureStreak: 3,
  stallMs: 600_000,
  contextPressure: 0.85,
}

test('budget pressure and hard pause have stable codes', () => {
  const pressure = budgetSignal({ used: 850, limit: 1_000, scope: 'run', at: '2026-11-14T00:00:00.000Z' }, thresholds)
  assert.equal(pressure.code, 'budget_pressure')
  assert.equal(pressure.severity, 'L2')
  assert.equal(pressure.suggestedAction, 'throttle')

  const pause = budgetSignal({ used: 960, limit: 1_000, at: '2026-11-14T00:00:00.000Z' }, thresholds)
  assert.equal(pause.code, 'budget_pause')
  assert.equal(pause.severity, 'L3')
  assert.equal(pause.suggestedAction, 'abort')

  assert.equal(budgetSignal({ used: 100, limit: 1_000 }, thresholds), null)
  assert.equal(budgetSignal({ used: 10, limit: 0 }, thresholds), null)
})

test('failure streaks and stalls need a real threshold crossing', () => {
  assert.equal(failureStreakSignal({ failures: 2 }, thresholds), null)
  const streak = failureStreakSignal({ failures: 3, ref: { taskId: 't1' } }, thresholds)
  assert.equal(streak.code, 'failure_streak')

  const quiet = stallSignal({ status: 'running', lastEventAt: '2026-11-14T00:00:00.000Z', now: Date.parse('2026-11-14T00:05:00.000Z') }, thresholds)
  assert.equal(quiet, null)
  const stalled = stallSignal({ status: 'running', lastEventAt: '2026-11-14T00:00:00.000Z', now: Date.parse('2026-11-14T00:11:00.000Z') }, thresholds)
  assert.equal(stalled.code, 'stalled_dispatch')
  assert.equal(stallSignal({ status: 'converged', lastEventAt: '2026-11-14T00:00:00.000Z', now: Date.parse('2026-11-15T00:00:00.000Z') }, thresholds), null)
})

test('one snapshot can produce several independent signals', () => {
  const signals = evaluateSnapshot({
    now: Date.parse('2026-11-14T02:00:00.000Z'),
    budget: { used: 970, limit: 1_000, at: '2026-11-14T02:00:00.000Z' },
    failures: 4,
    run: { status: 'running', lastEventAt: '2026-11-14T01:00:00.000Z' },
  }, { thresholds })
  assert.deepEqual(signals.map(signal => signal.code).sort(), ['budget_pause', 'failure_streak', 'stalled_dispatch'])
})
