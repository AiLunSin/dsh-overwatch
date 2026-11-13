/**
 * Decision execution: validate, authorize, act, verify, record.
 *
 * The executor is the only component that can change upstream state. It keeps
 * one serial queue, an idempotency key per decision, and writes intent, result,
 * and verification as separate hash-chained events, so a crash between them is
 * visible rather than silently completed.
 * @module dsh-overwatch/executor
 */

import { authorizeDecision, authorizePlan, idempotencyKey, planKey, validateDecision, validatePlan } from './policy.js'

/** @typedef {{ name: string, supports: (decision: import('./policy.js').Decision) => boolean, apply: (decision: any, context: any) => Promise<any>, verify: (decision: any, result: any, context: any) => Promise<{ ok: boolean, detail?: unknown }> }} Port */

export class Executor {
  /**
   * @param {object} options
   * @param {import('./store.js').WatchStore} options.store
   * @param {Port[]} options.ports
   * @param {{ mode: 'observe' | 'guard' | 'supervised', autopilot: Record<string, boolean> }} options.policy
   * @param {() => number} [options.clock]
   * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger]
   */
  constructor(options) {
    this.store = options.store
    this.ports = options.ports
    this.policy = options.policy
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    /** @type {Set<string>} */
    this.applied = new Set()
    /** @type {Map<string, { ok: boolean, duplicate: true, actionId: string, result: unknown, verified: boolean }>} */
    this.outcomes = new Map()
    /** Number of guard actions that reached a port (successful or not). */
    this.interventions = 0
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
  }

  /**
   * Rebuild the idempotency set from the watch log.
   * @returns {{ completed: number, incomplete: string[], damaged: string[] }}
   */
  recover() {
    const completed = new Map()
    const intended = new Map()
    const verified = new Set()
    for (const event of this.store.read()) {
      const payload = /** @type {any} */ (event.payload)
      if (event.type === 'watch/action/intended' && typeof payload?.key === 'string') {
        intended.set(payload.key, payload)
      }
      if (event.type === 'watch/action/executed' && typeof payload?.key === 'string') {
        completed.set(payload.key, payload)
      }
      if (event.type === 'watch/action/verified' && typeof payload?.key === 'string') {
        verified.add(payload.key)
      }
    }
    const incomplete = []
    const damaged = []
    for (const key of intended.keys()) {
      if (!completed.has(key)) incomplete.push(key)
      else if (!verified.has(key)) damaged.push(key)
      else this.applied.add(key)
    }
    return { completed: this.applied.size, incomplete, damaged }
  }

  /**
   * Execute one deterministic guard plan. The guard has no model and no free
   * text: the plan is validated and authorized by the same policy module the
   * watch officer uses, then executed on the same serial queue.
   * @param {unknown} rawPlan
   * @param {{ runId: string, evidenceIds?: ReadonlySet<string> | readonly string[] }} context
   * @returns {Promise<{ ok: boolean, code?: string, errors?: string[], requiresHuman?: boolean, actionId?: string, duplicate?: boolean, verified?: boolean, result?: unknown, reason?: string }>}
   */
  executePlan(rawPlan, context) {
    const task = this.queue.then(() => this.#executePlan(rawPlan, context))
    this.queue = task.catch(() => undefined)
    return task
  }

  /**
   * @param {unknown} rawPlan
   * @param {{ runId: string, evidenceIds?: ReadonlySet<string> | readonly string[] }} context
   */
  async #executePlan(rawPlan, context) {
    const validated = validatePlan(rawPlan, { runId: context.runId, evidenceIds: context.evidenceIds })
    if (!validated.ok) return { ok: false, code: 'INVALID_PLAN', errors: validated.errors }
    const plan = validated.plan
    const authorization = authorizePlan(plan, { mode: this.policy.mode, autopilot: this.policy.autopilot })
    if (!authorization.allowed) {
      this.store.append({
        type: 'watch/decision/denied',
        actor: 'policy',
        payload: {
          kind: 'guard_plan',
          caseId: plan.caseId,
          action: plan.kind,
          requiresHuman: authorization.requiresHuman,
          reason: authorization.reason,
        },
      })
      return { ok: false, code: 'DENIED', requiresHuman: authorization.requiresHuman, reason: authorization.reason }
    }

    const key = planKey(plan, context.runId)
    const previous = this.outcomes.get(key)
    if (previous !== undefined) return { ...previous, duplicate: true }

    const runId = typeof plan.params.runId === 'string' ? plan.params.runId : context.runId
    const decision = {
      schemaVersion: 1,
      caseId: plan.caseId,
      action: plan.kind,
      target: { kind: 'swarm_run', id: runId },
      params: { ...plan.params, runId },
      evidenceRefs: [...plan.evidenceRefs],
      reason: plan.reason,
    }
    const port = this.ports.find(candidate => candidate.supports(decision))
    if (port === undefined) {
      this.store.append({
        type: 'watch/decision/denied',
        actor: 'policy',
        payload: { kind: 'guard_plan', caseId: plan.caseId, action: plan.kind, reason: 'no port supports this target' },
      })
      return { ok: false, code: 'NO_PORT' }
    }

    const actionId = `act_${key.slice(0, 12)}`
    this.store.append({
      type: 'watch/action/intended',
      actor: 'guard',
      causationRef: { kind: 'case', caseId: plan.caseId },
      payload: {
        key,
        actionId,
        kind: plan.kind,
        target: decision.target,
        evidenceRefs: decision.evidenceRefs,
        severity: plan.severity,
        hardLimit: plan.hardLimit === true,
        params: plan.params,
      },
    })
    this.interventions += 1

    let result
    try {
      result = await port.apply(decision, { caseId: plan.caseId, actionId, runId })
    } catch (error) {
      const detail = errorMessage(error)
      this.store.append({
        type: 'watch/action/failed',
        actor: 'executor',
        causationRef: { kind: 'action', actionId },
        payload: { key, actionId, phase: 'apply', error: detail },
      })
      return { ok: false, code: 'APPLY_FAILED', actionId, reason: detail }
    }

    this.store.append({
      type: 'watch/action/executed',
      actor: 'executor',
      causationRef: { kind: 'action', actionId },
      payload: { key, actionId, kind: plan.kind, ok: result?.ok !== false, result: summarize(result) },
    })

    let verification
    try {
      verification = await port.verify(decision, result, { caseId: plan.caseId, actionId, runId })
    } catch (error) {
      verification = { ok: false, detail: { error: errorMessage(error) } }
    }
    this.store.append({
      type: verification.ok ? 'watch/action/verified' : 'watch/action/unverified',
      actor: 'executor',
      causationRef: { kind: 'action', actionId },
      payload: { key, actionId, kind: plan.kind, ok: verification.ok, detail: summarize(verification.detail) },
    })

    const outcome = { ok: verification.ok, actionId, result: summarize(result), verified: verification.ok }
    this.outcomes.set(key, { ...outcome, duplicate: true })
    if (verification.ok) this.applied.add(key)
    else this.logger?.warn?.(`[overwatch] guard action ${actionId} could not be verified`)
    return outcome
  }

  /**
   * Execute one decision. The promise settles after all owned work is quiescent
   * and every state transition is in the watch log.
   * @param {unknown} rawDecision
   * @param {{ caseId: string, evidenceIds: ReadonlySet<string> | readonly string[], hardLimit?: boolean, runId?: string }} context
   * @returns {Promise<{ ok: boolean, code?: string, errors?: string[], requiresHuman?: boolean, actionId?: string, duplicate?: boolean, verified?: boolean, result?: unknown, reason?: string }>}
   */
  execute(rawDecision, context) {
    const task = this.queue.then(() => this.#execute(rawDecision, context))
    this.queue = task.catch(() => undefined)
    return task
  }

  /**
   * @param {unknown} rawDecision
   * @param {{ caseId: string, evidenceIds: ReadonlySet<string> | readonly string[], hardLimit?: boolean, runId?: string }} context
   */
  async #execute(rawDecision, context) {
    const validated = validateDecision(rawDecision, { caseId: context.caseId, evidenceIds: context.evidenceIds })
    if (!validated.ok) {
      return { ok: false, code: 'INVALID_DECISION', errors: validated.errors }
    }
    const decision = validated.decision
    const authorization = authorizeDecision(decision, {
      mode: this.policy.mode,
      autopilot: this.policy.autopilot,
      hardLimit: context.hardLimit,
    })
    if (!authorization.allowed) {
      this.store.append({
        type: 'watch/decision/denied',
        actor: 'policy',
        payload: {
          caseId: decision.caseId,
          action: decision.action,
          requiresHuman: authorization.requiresHuman,
          reason: authorization.reason,
        },
      })
      return { ok: false, code: 'DENIED', requiresHuman: authorization.requiresHuman, reason: authorization.reason }
    }

    const key = idempotencyKey(decision)
    const previous = this.outcomes.get(key)
    if (previous !== undefined) return { ...previous, duplicate: true }

    const port = this.ports.find(candidate => candidate.supports(decision))
    if (port === undefined) {
      this.store.append({
        type: 'watch/decision/denied',
        actor: 'policy',
        payload: { caseId: decision.caseId, action: decision.action, reason: 'no port supports this target' },
      })
      return { ok: false, code: 'NO_PORT' }
    }

    const actionId = `act_${key.slice(0, 12)}`
    this.store.append({
      type: 'watch/action/intended',
      actor: 'watch',
      causationRef: { kind: 'case', caseId: decision.caseId },
      payload: { key, actionId, kind: decision.action, target: decision.target, evidenceRefs: decision.evidenceRefs },
    })

    let result
    try {
      result = await port.apply(decision, { caseId: context.caseId, actionId, signal: undefined })
    } catch (error) {
      const detail = errorMessage(error)
      this.store.append({
        type: 'watch/action/failed',
        actor: 'executor',
        causationRef: { kind: 'action', actionId },
        payload: { key, actionId, phase: 'apply', error: detail },
      })
      return { ok: false, code: 'APPLY_FAILED', actionId, reason: detail }
    }

    this.store.append({
      type: 'watch/action/executed',
      actor: 'executor',
      causationRef: { kind: 'action', actionId },
      payload: { key, actionId, kind: decision.action, ok: result?.ok !== false, result: summarize(result) },
    })

    let verification
    try {
      verification = await port.verify(decision, result, { caseId: context.caseId, actionId })
    } catch (error) {
      verification = { ok: false, detail: { error: errorMessage(error) } }
    }
    this.store.append({
      type: verification.ok ? 'watch/action/verified' : 'watch/action/unverified',
      actor: 'executor',
      causationRef: { kind: 'action', actionId },
      payload: { key, actionId, kind: decision.action, ok: verification.ok, detail: summarize(verification.detail) },
    })

    const outcome = { ok: verification.ok, actionId, result: summarize(result), verified: verification.ok }
    this.outcomes.set(key, { ...outcome, duplicate: true })
    if (verification.ok) this.applied.add(key)
    else this.logger?.warn?.(`[overwatch] action ${actionId} could not be verified`)
    return outcome
  }
}

/** @param {unknown} value */
function summarize(value) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (text.length <= 2_000) return JSON.parse(text)
    return { truncated: true, bytes: text.length }
  } catch {
    return { unserializable: true }
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
