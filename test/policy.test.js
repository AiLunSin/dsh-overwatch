import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeDecision, idempotencyKey, validateDecision } from '../src/policy.js'

const evidence = new Set(['ev-1'])

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: 'case-1',
    action: 'throttle',
    target: { kind: 'swarm_run', id: 'run-1' },
    params: { runId: 'run-1' },
    evidenceRefs: ['ev-1'],
    reason: 'budget at 96%',
    confidence: 0.8,
    ...overrides,
  }
}

test('a well-formed L2 decision validates', () => {
  const result = validateDecision(decision(), { caseId: 'case-1', evidenceIds: evidence })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.decision.action, 'throttle')
    assert.deepEqual(result.decision.evidenceRefs, ['ev-1'])
  }
})

test('L2+ decisions require evidence and unknown refs fail', () => {
  const missing = validateDecision(decision({ evidenceRefs: [] }), { caseId: 'case-1' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.errors.join(' '), /requires at least one evidence ref/)

  const unknown = validateDecision(decision({ evidenceRefs: ['ev-unknown'] }), { caseId: 'case-1', evidenceIds: evidence })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.errors.join(' '), /unknown evidence/)
})

test('a mismatched case, bad action, or missing reason fails', () => {
  assert.equal(validateDecision(decision({ caseId: 'other' }), { caseId: 'case-1' }).ok, false)
  assert.equal(validateDecision(decision({ action: 'rm -rf' })).ok, false)
  assert.equal(validateDecision(decision({ reason: '   ' })).ok, false)
  assert.equal(validateDecision(decision({ target: { kind: 'swarm_run', id: '' } })).ok, false)
})

test('observe mode never executes, guard mode never consumes model decisions', () => {
  const throttle = validateDecision(decision()).decision
  const observe = authorizeDecision(throttle, { mode: 'observe', autopilot: { throttle: true } })
  assert.equal(observe.allowed, false)
  assert.equal(observe.requiresHuman, false)

  const guard = authorizeDecision(throttle, { mode: 'guard', autopilot: { throttle: true } })
  assert.equal(guard.allowed, false)

  const supervised = authorizeDecision(throttle, { mode: 'supervised', autopilot: { throttle: true } })
  assert.equal(supervised.allowed, true)
})

test('pause is human-only by default and abort needs a hard limit', () => {
  const pause = validateDecision(decision({ action: 'pause', params: {} })).decision
  const pauseAuth = authorizeDecision(pause, { mode: 'supervised', autopilot: { pause: false, abortOnHardLimit: true } })
  assert.equal(pauseAuth.allowed, false)
  assert.equal(pauseAuth.requiresHuman, true)

  const abort = validateDecision(decision({ action: 'abort', params: {} })).decision
  assert.equal(authorizeDecision(abort, { mode: 'supervised', autopilot: { abortOnHardLimit: true } }).allowed, false)
  assert.equal(authorizeDecision(abort, { mode: 'supervised', autopilot: { abortOnHardLimit: true }, hardLimit: true }).allowed, true)
})

test('idempotency ignores reason text but not evidence or params', () => {
  const first = validateDecision(decision()).decision
  const same = validateDecision(decision({ reason: 'a different sentence' })).decision
  const different = validateDecision(decision({ evidenceRefs: ['ev-1'], params: { runId: 'run-2' } })).decision
  assert.equal(idempotencyKey(first), idempotencyKey(same))
  assert.notEqual(idempotencyKey(first), idempotencyKey(different))
})
