import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeDecision, authorizePlan, idempotencyKey, planKey, validateDecision, validatePlan } from '../src/policy.js'

const evidence = new Set(['ev-1'])

function guardPlan(overrides = {}) {
  return {
    kind: 'throttle',
    caseId: 'case-1',
    severity: 'L2',
    reason: 'budget pressure crossed the configured threshold',
    evidenceRefs: ['ev-1'],
    params: { runId: 'run-1', minutes: 10 },
    hardLimit: false,
    ...overrides,
  }
}

test('a guard throttle plan validates with bounded minutes', () => {
  const result = validatePlan(guardPlan(), { evidenceIds: evidence, runId: 'run-1' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.plan.kind, 'throttle')

  assert.equal(validatePlan(guardPlan({ params: { runId: 'run-1', minutes: 0 } })).ok, false)
  assert.equal(validatePlan(guardPlan({ params: { runId: 'run-1', minutes: 31 } })).ok, false)
  assert.equal(validatePlan(guardPlan({ evidenceRefs: [] })).ok, false)
  assert.equal(validatePlan(guardPlan({ evidenceRefs: ['ev-x'] }), { evidenceIds: evidence }).ok, false)
  assert.equal(validatePlan(guardPlan({ kind: 'coach' })).ok, false)
})

test('resume is an internal plan that needs the throttle action id', () => {
  const plan = guardPlan({ kind: 'resume', params: { runId: 'run-1', ofActionId: 'act_1', automatic: true } })
  const valid = validatePlan(plan, { evidenceIds: evidence })
  assert.equal(valid.ok, true)
  assert.equal(validatePlan(guardPlan({ kind: 'resume', params: { runId: 'run-1' } })).ok, false)
  assert.equal(validatePlan(guardPlan({ kind: 'resume', params: { runId: 'run-1', ofActionId: 'act_1' } })).ok, false)
})

test('guard authorization follows the hard-limit switches, not the watch matrix', () => {
  const autopilot = { throttle: true, pause: false, pauseOnHardLimit: true, abortOnHardLimit: true }
  const throttle = validatePlan(guardPlan()).plan
  assert.equal(authorizePlan(throttle, { mode: 'guard', autopilot }).allowed, true)
  assert.equal(authorizePlan(throttle, { mode: 'observe', autopilot }).allowed, false)
  assert.equal(authorizePlan(throttle, { mode: 'guard', autopilot: { ...autopilot, throttle: false } }).allowed, false)

  const pause = validatePlan(guardPlan({ kind: 'pause', severity: 'L3', hardLimit: true, params: { runId: 'run-1' } })).plan
  assert.equal(authorizePlan(pause, { mode: 'guard', autopilot }).allowed, true)
  assert.equal(authorizePlan(pause, { mode: 'guard', autopilot: { ...autopilot, pauseOnHardLimit: false } }).allowed, false)
  assert.equal(authorizePlan(pause, { mode: 'guard', autopilot }).allowed, pause.hardLimit === true)

  const abort = validatePlan(guardPlan({ kind: 'abort', severity: 'L4', hardLimit: true, params: { runId: 'run-1' } })).plan
  assert.equal(authorizePlan(abort, { mode: 'guard', autopilot }).allowed, true)
  assert.equal(authorizePlan(abort, { mode: 'guard', autopilot: { ...autopilot, abortOnHardLimit: false } }).allowed, false)

  const resume = validatePlan(guardPlan({ kind: 'resume', params: { runId: 'run-1', ofActionId: 'act_1', automatic: true } })).plan
  assert.equal(authorizePlan(resume, { mode: 'guard', autopilot }).allowed, true)
})

test('guard plan keys are stable across evidence order but sensitive to params', () => {
  const first = validatePlan(guardPlan({ evidenceRefs: ['ev-1', 'ev-2'] })).plan
  const reordered = validatePlan(guardPlan({ evidenceRefs: ['ev-2', 'ev-1'] })).plan
  const otherMinutes = validatePlan(guardPlan({ params: { runId: 'run-1', minutes: 5 } })).plan
  assert.equal(planKey(first, 'run-1'), planKey(reordered, 'run-1'))
  assert.notEqual(planKey(first, 'run-1'), planKey(otherMinutes, 'run-1'))
  assert.notEqual(planKey(first, 'run-1'), planKey(first, 'run-2'))
})

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

test('low confidence cannot buy a mutating action', () => {
  const low = validateDecision(decision({ confidence: 0.5 }))
  assert.equal(low.ok, false)
  if (!low.ok) assert.match(low.errors.join(' '), /confidence below 0.6/)
  assert.equal(validateDecision(decision({ confidence: 0.5, action: 'escalate', params: {} })).ok, true)
  assert.equal(validateDecision(decision({ confidence: 0.6 })).ok, true)
})

test('a decision cannot target another supervised run or its params.runId', () => {
  const target = validateDecision(decision({ target: { kind: 'swarm_run', id: 'run-2' } }), {
    caseId: 'case-1',
    runId: 'run-1',
    evidenceIds: evidence,
  })
  assert.equal(target.ok, false)
  if (!target.ok) assert.match(target.errors.join(' '), /target\.id must be the supervised runId/)

  const param = validateDecision(decision({ params: { runId: 'run-2' } }), {
    caseId: 'case-1',
    runId: 'run-1',
    evidenceIds: evidence,
  })
  assert.equal(param.ok, false)
  if (!param.ok) assert.match(param.errors.join(' '), /params\.runId must be the supervised runId/)

  assert.equal(validateDecision(decision(), { caseId: 'case-1', runId: 'run-1', evidenceIds: evidence }).ok, true)
})

test('throttle minutes and coach text are bounded', () => {
  assert.equal(validateDecision(decision({ params: { runId: 'run-1', minutes: 0 } })).ok, false)
  assert.equal(validateDecision(decision({ params: { runId: 'run-1', minutes: 31 } })).ok, false)
  assert.equal(validateDecision(decision({ params: { runId: 'run-1', minutes: 10 } })).ok, true)
  assert.equal(validateDecision(decision({
    action: 'coach',
    params: { runId: 'run-1', text: 'x'.repeat(281) },
  })).ok, false)
  assert.equal(validateDecision(decision({
    action: 'coach',
    params: { runId: 'run-1', text: 'short' },
  })).ok, true)
})

test('idempotency ignores params key order', () => {
  const first = validateDecision(decision({ params: { runId: 'run-1', minutes: 5 } })).decision
  const reordered = validateDecision(decision({ params: { minutes: 5, runId: 'run-1' } })).decision
  assert.equal(idempotencyKey(first), idempotencyKey(reordered))
})

test('guard plan runId cannot diverge from the executor run context', () => {
  const plan = guardPlan({ params: { runId: 'run-2', minutes: 10 } })
  const result = validatePlan(plan, { evidenceIds: evidence, runId: 'run-1' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join(' '), /params\.runId must be the supervised runId/)
})

test('idempotency ignores reason text but not evidence or params', () => {
  const first = validateDecision(decision()).decision
  const same = validateDecision(decision({ reason: 'a different sentence' })).decision
  const different = validateDecision(decision({ evidenceRefs: ['ev-1'], params: { runId: 'run-2' } })).decision
  assert.equal(idempotencyKey(first), idempotencyKey(same))
  assert.notEqual(idempotencyKey(first), idempotencyKey(different))
})
