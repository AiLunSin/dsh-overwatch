import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

test('defaults resolve and freeze', () => {
  const config = resolveConfig({}, { resolveDir: () => '/tmp/overwatch' })
  assert.equal(config.mode, 'guard')
  assert.equal(config.dataDir, '/tmp/overwatch')
  assert.equal(config.thresholds.budgetPause, 0.95)
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.policy.autopilot), true)
})

test('nested overrides merge without dropping siblings', () => {
  const config = resolveConfig({
    mode: 'supervised',
    thresholds: { budgetPressure: 0.7 },
    policy: { autopilot: { pause: true } },
  }, { resolveDir: () => '/tmp/x' })
  assert.equal(config.mode, 'supervised')
  assert.equal(config.thresholds.budgetPressure, 0.7)
  assert.equal(config.thresholds.budgetPause, 0.95)
  assert.equal(config.policy.autopilot.pause, true)
  assert.equal(config.policy.autopilot.throttle, true)
})

test('invalid or contradictory config fails loudly', () => {
  assert.throws(() => resolveConfig({ mode: 'yolo' }), /mode must be one of/)
  assert.throws(() => resolveConfig({ supervisor: { reserveRatio: 0.9 } }), /reserveRatio/)
  assert.throws(() => resolveConfig({ thresholds: { budgetPressure: 0.99, budgetPause: 0.9 } }), /budgetPressure/)
  assert.throws(() => resolveConfig({ http: { token: 42 } }), /token/)
})

test('empty dataDir falls back to the DSH home convention', () => {
  const config = resolveConfig({ storage: { dataDir: '' } })
  assert.match(config.dataDir, /overwatch$/)
})

test('the M1 guard switches have explicit defaults and bounds', () => {
  const config = resolveConfig({})
  assert.equal(config.policy.autopilot.pauseOnHardLimit, true)
  assert.equal(config.policy.autopilot.pause, false)
  assert.equal(config.policy.throttleMinutes, 10)
  assert.equal(config.ports.swarmToken, '')
  assert.throws(() => resolveConfig({ policy: { throttleMinutes: 0 } }), /throttleMinutes/)
  assert.throws(() => resolveConfig({ policy: { throttleMinutes: 61 } }), /throttleMinutes/)
  assert.throws(() => resolveConfig({ ports: { swarmToken: 42 } }), /swarmToken/)
})
