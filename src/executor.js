/**
 * Decision execution: validate, authorize, act, verify, record.
 *
 * The executor is the only component that can change upstream state. It keeps
 * one serial queue, an idempotency key per decision, and writes intent, result,
 * and verification as separate hash-chained events, so a crash between them is
 * visible rather than silently completed.
 * @module dsh-overwatch/executor
 */

import { authorizeDecision, authorizeHumanDecision, authorizeHumanPlan, authorizePlan, idempotencyKey, planKey, validateDecision, validatePlan } from './policy.js'

/** @typedef {{ name: string, supports: (decision: import('./policy.js').Decision) => boolean, apply: (decision: any, context: any) => Promise<any>, verify: (decision: any, result: any, context: any) => Promise<{ ok: boolean, detail?: unknown }> }} Port */

export class Executor {
  /**
   * @param {object} options
   * @param {import('./store.js').WatchStore} options.store
   * @param {Port[]} options.ports
   * @param {{ mode: 'observe' | 'guard' | 'supervised', autopilot: Record<string, boolean>, maxAutoInterventions?: number }} options.policy
   * @param {() => number} [options.clock]
   * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger]
   * @param {{ request: (input: any) => { approval: any, existing: boolean } }} [options.approvals] queue for human approval
   */
  constructor(options) {
    this.store = options.store
    this.ports = options.ports
    this.policy = options.policy
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    this.approvals = options.approvals ?? null
    /** @type {Set<string>} */
    this.applied = new Set()
    /** @type {Map<string, { ok: boolean, duplicate: true, actionId: string, result: unknown, verified: boolean, code?: string }>} */
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
    const unknown = new Set()
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
      if (event.type === 'watch/action/unknown' && typeof payload?.key === 'string') {
        unknown.add(payload.key)
      }
    }
    this.applied = new Set()
    const incomplete = []
    const damaged = []
    for (const key of intended.keys()) {
      if (!completed.has(key)) incomplete.push(key)
      else if (!verified.has(key)) damaged.push(key)
      else this.applied.add(key)
    }
    for (const key of this.applied) {
      const executed = completed.get(key)
      this.outcomes.set(key, {
        ok: executed?.ok !== false,
        duplicate: true,
        actionId: String(executed?.actionId ?? ''),
        result: executed?.result ?? null,
        verified: true,
      })
    }
    // An intended-but-never-executed action and an executed-but-unverified
    // action are both unsafe to replay: the upstream may or may not have
    // applied them. Record them as unknown and make a repeated decision a
    // no-op; a human can reconcile from the upstream evidence.
    for (const [key, phase] of [...incomplete.map(key => [key, 'intended']), ...damaged.map(key => [key, 'executed'])]) {
      const payload = intended.get(key)
      const actionId = String(payload?.actionId ?? `act_${key.slice(0, 12)}`)
      if (!this.outcomes.has(key)) {
        this.outcomes.set(key, {
          ok: false,
          duplicate: true,
          actionId,
          result: null,
          verified: false,
          code: 'UNKNOWN',
        })
      }
      if (!unknown.has(key)) {
        try {
          this.store.append({
            type: 'watch/action/unknown',
            actor: 'executor',
            causationRef: { kind: 'action', actionId },
            payload: { key, actionId, phase, reason: phase === 'intended' ? 'crash between intent and execution' : 'crash between execution and verification' },
          })
        } catch {
          // The caller still gets the incomplete/damaged list; a full store is
          // reported by health rather than crashing recovery.
        }
      }
    }
    this.interventions = Math.max(this.interventions, this.applied.size)
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
    const authorization = context.humanApproved === true
      ? authorizeHumanPlan(plan, { mode: this.policy.mode })
      : authorizePlan(plan, { mode: this.policy.mode, autopilot: this.policy.autopilot })
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
      if (authorization.requiresHuman && this.approvals !== null && context.humanApproved !== true) {
        return this.#enqueuePlanApproval(plan, context.runId, authorization.reason)
      }
      return { ok: false, code: 'DENIED', requiresHuman: authorization.requiresHuman, reason: authorization.reason }
    }

    const key = planKey(plan, context.runId)
    const previous = this.outcomes.get(key)
    if (previous !== undefined) return { ...previous, duplicate: true }

    const runId = context.runId
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
        approvedBy: context.humanApproved === true ? 'human' : null,
        approvalId: context.approvalId ?? null,
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
    const runId = typeof context.runId === 'string' ? context.runId : undefined
    const validated = validateDecision(rawDecision, { caseId: context.caseId, runId, evidenceIds: context.evidenceIds })
    if (!validated.ok) {
      return { ok: false, code: 'INVALID_DECISION', errors: validated.errors }
    }
    const decision = validated.decision
    const authorization = context.humanApproved === true
      ? authorizeHumanDecision(decision, { mode: this.policy.mode })
      : authorizeDecision(decision, {
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
          target: decision.target,
          params: decision.params,
          requiresHuman: authorization.requiresHuman,
          reason: authorization.reason,
        },
      })
      if (authorization.requiresHuman && this.approvals !== null && context.humanApproved !== true) {
        return this.#enqueueDecisionApproval(decision, context, authorization.reason)
      }
      return { ok: false, code: 'DENIED', requiresHuman: authorization.requiresHuman, reason: authorization.reason }
    }

    const key = idempotencyKey(decision)
    const previous = this.outcomes.get(key)
    if (previous !== undefined) return { ...previous, duplicate: true }

    const mutating = decision.action !== 'notice' && decision.action !== 'escalate'
    const maxAutoInterventions = Number.isSafeInteger(this.policy.maxAutoInterventions)
      ? /** @type {number} */ (this.policy.maxAutoInterventions)
      : Number.POSITIVE_INFINITY
    if (mutating && context.humanApproved !== true && this.interventions >= maxAutoInterventions) {
      const reason = `auto intervention limit ${maxAutoInterventions} reached`
      this.store.append({
        type: 'watch/decision/denied',
        actor: 'policy',
        payload: { caseId: decision.caseId, action: decision.action, requiresHuman: true, reason },
      })
      return { ok: false, code: 'AUTO_INTERVENTION_LIMIT', requiresHuman: true, reason }
    }

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
      payload: {
        key,
        actionId,
        kind: decision.action,
        target: decision.target,
        params: decision.params,
        evidenceRefs: decision.evidenceRefs,
        runId: runId ?? null,
        approvedBy: context.humanApproved === true ? 'human' : null,
        approvalId: context.approvalId ?? null,
      },
    })
    if (mutating) this.interventions += 1

    let result
    try {
      result = await port.apply(decision, { caseId: context.caseId, actionId, signal: undefined, runId })
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
      verification = await port.verify(decision, result, { caseId: context.caseId, actionId, runId })
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

  /**
   * Persist a decision that the policy says needs a human, returning a stable
   * pending approval instead of a plain denial.
   * @param {import('./policy.js').Decision} decision
   * @param {{ caseId: string, hardLimit?: boolean, runId?: string }} context
   * @param {string} reason
   */
  #enqueueDecisionApproval(decision, context, reason) {
    const queued = this.approvals.request({
      kind: 'decision',
      key: idempotencyKey(decision),
      caseId: decision.caseId,
      severity: null,
      action: decision.action,
      target: decision.target,
      params: decision.params,
      evidenceRefs: decision.evidenceRefs,
      reason,
      request: { decision },
    })
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      requiresHuman: true,
      approval: { id: queued.approval.id, status: queued.approval.status, expiresAt: queued.approval.expiresAt },
      reason,
    }
  }

  /**
   * @param {import('./policy.js').GuardPlanInput} plan
   * @param {string} runId
   * @param {string} reason
   */
  #enqueuePlanApproval(plan, runId, reason) {
    const queued = this.approvals.request({
      kind: 'guard_plan',
      key: planKey(plan, runId),
      caseId: plan.caseId,
      severity: plan.severity,
      action: plan.kind,
      target: { kind: 'swarm_run', id: runId },
      params: plan.params,
      evidenceRefs: plan.evidenceRefs,
      reason,
      request: { plan },
    })
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      requiresHuman: true,
      approval: { id: queued.approval.id, status: queued.approval.status, expiresAt: queued.approval.expiresAt },
      reason,
    }
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
