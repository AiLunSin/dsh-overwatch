/**
 * Decision validation and the authorization matrix.
 *
 * The watch officer only chooses an enum action with a target, evidence refs
 * and a reason. This module is the gate: a decision that fails validation or
 * authorization never reaches the executor. It is pure and synchronous.
 * @module dsh-overwatch/policy
 */

import { sha256 } from './util.js'

/** Actions the v1 watch officer may choose. */
export const ACTIONS = Object.freeze(['notice', 'coach', 'throttle', 'pause', 'abort', 'escalate'])

/** Minimum authorization level per action. L2+ needs at least one evidence ref. */
export const ACTION_LEVEL = Object.freeze({
  notice: 1,
  coach: 1,
  escalate: 1,
  throttle: 2,
  pause: 2,
  abort: 3,
})

export const TARGET_KINDS = Object.freeze(['swarm_run', 'swarm_member', 'swarm_task', 'session'])

/** Decision schema version accepted by this build. */
export const DECISION_VERSION = 1

/**
 * @typedef {object} Decision
 * @property {1} schemaVersion
 * @property {string} caseId
 * @property {'notice'|'coach'|'throttle'|'pause'|'abort'|'escalate'} action
 * @property {{ kind: string, id: string }} target
 * @property {Record<string, unknown>} params
 * @property {string[]} evidenceRefs
 * @property {string} reason
 * @property {number} [confidence]
 */

/**
 * Validate an untrusted decision value.
 * @param {unknown} raw
 * @param {{ caseId?: string, evidenceIds?: ReadonlySet<string> | readonly string[], maxReasonBytes?: number }} [context]
 * @returns {{ ok: true, decision: Decision } | { ok: false, errors: string[] }}
 */
export function validateDecision(raw, context = {}) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['decision must be an object'] }

  const decision = /** @type {Record<string, unknown>} */ (raw)
  if (decision.schemaVersion !== DECISION_VERSION) errors.push(`schemaVersion must be ${DECISION_VERSION}`)
  if (typeof decision.caseId !== 'string' || decision.caseId === '') errors.push('caseId must be a non-empty string')
  else if (context.caseId !== undefined && decision.caseId !== context.caseId) errors.push('caseId does not match the open case')
  if (typeof decision.action !== 'string' || !ACTIONS.includes(decision.action)) {
    errors.push(`action must be one of ${ACTIONS.join(', ')}`)
  }
  if (!isPlainObject(decision.target)) errors.push('target must be an object')
  else {
    const target = /** @type {Record<string, unknown>} */ (decision.target)
    if (typeof target.kind !== 'string' || !TARGET_KINDS.includes(target.kind)) errors.push(`target.kind must be one of ${TARGET_KINDS.join(', ')}`)
    if (typeof target.id !== 'string' || target.id === '') errors.push('target.id must be a non-empty string')
  }
  if (decision.params !== undefined && !isPlainObject(decision.params)) errors.push('params must be an object when present')
  if (!Array.isArray(decision.evidenceRefs)) errors.push('evidenceRefs must be an array')
  else {
    if (!decision.evidenceRefs.every(ref => typeof ref === 'string' && ref !== '')) errors.push('evidenceRefs must contain non-empty strings')
    if (new Set(decision.evidenceRefs).size !== decision.evidenceRefs.length) errors.push('evidenceRefs must not contain duplicates')
  }
  if (typeof decision.reason !== 'string' || decision.reason.trim() === '') errors.push('reason must be a non-empty string')
  else if (Buffer.byteLength(decision.reason, 'utf8') > (context.maxReasonBytes ?? 2_048)) errors.push('reason is too large')
  if (decision.confidence !== undefined && (typeof decision.confidence !== 'number' || decision.confidence < 0 || decision.confidence > 1)) {
    errors.push('confidence must be a number between 0 and 1')
  }

  if (errors.length === 0) {
    const action = /** @type {Decision['action']} */ (decision.action)
    const level = ACTION_LEVEL[action]
    const refs = /** @type {string[]} */ (decision.evidenceRefs)
    if (level >= 2 && refs.length === 0) errors.push(`${action} is L2+ and requires at least one evidence ref`)
    if (context.evidenceIds !== undefined) {
      const known = context.evidenceIds instanceof Set ? context.evidenceIds : new Set(context.evidenceIds)
      const unknown = refs.filter(ref => !known.has(ref))
      if (unknown.length > 0) errors.push(`unknown evidence ref(s): ${unknown.join(', ')}`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    decision: {
      schemaVersion: DECISION_VERSION,
      caseId: /** @type {string} */ (decision.caseId),
      action: /** @type {Decision['action']} */ (decision.action),
      target: {
        kind: /** @type {{ kind: string, id: string }} */ (decision.target).kind,
        id: /** @type {{ kind: string, id: string }} */ (decision.target).id,
      },
      params: isPlainObject(decision.params) ? /** @type {Record<string, unknown>} */ (decision.params) : {},
      evidenceRefs: [.../** @type {string[]} */ (decision.evidenceRefs)],
      reason: /** @type {string} */ (decision.reason),
      ...(typeof decision.confidence === 'number' ? { confidence: decision.confidence } : {}),
    },
  }
}

/**
 * Apply the configured mode and autopilot matrix. A denial is final; the caller
 * records it as `requires human` rather than retrying.
 * @param {Decision} decision
 * @param {{ mode: 'observe' | 'guard' | 'supervised', autopilot: Record<string, boolean>, hardLimit?: boolean }} context
 * @returns {{ allowed: boolean, requiresHuman: boolean, reason: string }}
 */
export function authorizeDecision(decision, context) {
  const level = ACTION_LEVEL[decision.action]
  if (context.mode === 'observe') {
    if (decision.action === 'notice' || decision.action === 'escalate') return allow('observe mode only records notices and escalations')
    return deny('observe mode never executes actions')
  }
  if (context.mode === 'guard') {
    // The guard path is deterministic and does not consume model decisions.
    return deny('guard mode has no watch officer; only the deterministic guard may act')
  }
  if (decision.action === 'notice' || decision.action === 'escalate') {
    return allow('non-mutating action')
  }
  if (decision.action === 'abort') {
    if (context.autopilot.abortOnHardLimit === true && context.hardLimit === true) return allow('abort allowed on a hard limit')
    return { allowed: false, requiresHuman: true, reason: 'abort needs a human unless it stops a hard limit' }
  }
  if (decision.action === 'pause' && context.autopilot.pause !== true) {
    return { allowed: false, requiresHuman: true, reason: 'pause is disabled in autopilot' }
  }
  if (decision.action === 'throttle' && context.autopilot.throttle !== true) {
    return { allowed: false, requiresHuman: true, reason: 'throttle is disabled in autopilot' }
  }
  if (level >= 2 && decision.evidenceRefs.length === 0) {
    return deny('L2+ action without evidence is downgraded to escalate')
  }
  return allow('autopilot allows this action')
}

/** @param {string} reason @returns {{ allowed: true, requiresHuman: false, reason: string }} */
function allow(reason) {
  return { allowed: true, requiresHuman: false, reason }
}

/** @param {string} reason @returns {{ allowed: false, requiresHuman: false, reason: string }} */
function deny(reason) {
  return { allowed: false, requiresHuman: false, reason }
}

/**
 * Stable idempotency key for one decision. Two identical decisions for one case
 * and target map to the same key; a changed reason or evidence set does not
 * create a second physical action.
 * @param {Decision} decision
 * @returns {string}
 */
export function idempotencyKey(decision) {
  return sha256(JSON.stringify({
    caseId: decision.caseId,
    action: decision.action,
    target: decision.target,
    evidenceRefs: [...decision.evidenceRefs].sort(),
    params: decision.params,
  })).slice(0, 32)
}

/**
 * The actions a human must approve even in supervised mode (v1).
 * @param {Decision} decision
 * @param {{ hardLimit?: boolean }} [context]
 * @returns {boolean}
 */
export function requiresHumanApproval(decision, context = {}) {
  if (decision.action === 'notice' || decision.action === 'coach' || decision.action === 'escalate') return false
  if (decision.action === 'abort' && context.hardLimit === true) return false
  return true
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
