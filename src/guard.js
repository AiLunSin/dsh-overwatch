/**
 * Deterministic hard gate ("guard").
 *
 * The guard never asks a model. It reads the sampled snapshot, decides whether a
 * hard threshold was crossed, and emits an internal plan for the executor. Every
 * plan is evidence-backed and tied to a case; when no case can be opened the
 * guard records a notice instead of acting without a record.
 *
 * Thresholds:
 * - `budgetPressure` (default 0.80) → throttle: pause, resume after N minutes.
 * - `budgetPause`   (default 0.95) → pause, no automatic resume.
 * - 1.00                          → abort.
 * @module dsh-overwatch/guard
 */

import { evidenceId } from './signals.js'

/** Action priority: a higher rank pre-empts a lower one in the same tick. */
const PLAN_PRIORITY = Object.freeze({ abort: 5, pause: 4, resume: 3, throttle: 2, notice: 1 })

/** @typedef {'notice' | 'throttle' | 'pause' | 'abort' | 'resume'} GuardAction */

/**
 * @typedef {object} GuardPlan
 * @property {GuardAction} kind
 * @property {string} caseId
 * @property {'L1' | 'L2' | 'L3' | 'L4'} severity
 * @property {string} reason
 * @property {string[]} evidenceRefs
 * @property {Record<string, unknown>} params
 * @property {boolean} hardLimit
 */

/**
 * @param {object} input
 * @param {any} input.snapshot normalized snapshot from the probe
 * @param {import('./cases.js').CaseManager} input.cases
 * @param {{ interventions: number, throttle: { active: boolean, actionId: string, caseId: string, dueAt: number, minutes: number } | null, lastActions: Map<string, number> }} input.state
 * @param {typeof import('./config.js').DEFAULT_CONFIG} input.config
 * @param {string} input.runId
 * @param {number} input.now
 * @returns {{ plans: GuardPlan[], notices: Array<{ code: string, reason: string, caseId?: string }> }}
 */
export function evaluateGuard(input) {
  const { snapshot, cases, state, config, now } = input
  /** @type {GuardPlan[]} */
  const plans = []
  /** @type {Array<{ code: string, reason: string, caseId?: string }>} */
  const notices = []

  const status = String(snapshot?.status ?? 'unknown')
  if (!['running', 'paused', 'draining'].includes(status)) return { plans, notices }

  const budget = snapshot?.budget ?? {}
  const limit = Number(budget.limit ?? 0)
  const spent = Number(budget.spent ?? 0)
  const ratio = limit > 0 ? spent / limit : 0

  if (snapshot?.eventGap !== null && snapshot?.eventGap !== undefined) {
    const signal = {
      code: 'log_integrity',
      severity: /** @type {'L4'} */ ('L4'),
      summary: 'swarm event stream gap',
      suggestedAction: 'abort',
      evidence: {
        id: evidenceId('swarm', 'log_integrity', `${snapshot.eventGap.expectedSeq}:${snapshot.eventGap.actualSeq}`),
        source: 'swarm',
        kind: 'log_integrity',
        at: new Date(now).toISOString(),
        ref: snapshot.eventGap.ref ?? null,
        observed: snapshot.eventGap,
      },
    }
    return {
      plans: plansFor({
        runId: input.runId, cases, config, state, signal, kind: 'abort', severity: 'L4', hardLimit: true, now,
        reason: `swarm events are not contiguous (expected ${String(snapshot.eventGap.expectedSeq)}, got ${String(snapshot.eventGap.actualSeq)}); refusing to supervise an untrusted stream`,
      }, notices),
      notices,
    }
  }

  if (state.throttle !== null && state.throttle.active && state.throttle.dueAt <= now) {
    const record = cases.get(state.throttle.caseId)
    plans.push({
      kind: 'resume',
      caseId: state.throttle.caseId,
      severity: 'L2',
      reason: `throttle window of ${state.throttle.minutes} minute(s) elapsed; resuming a run this guard paused`,
      evidenceRefs: record === null ? [] : record.evidence.map(entry => String(entry.id)).slice(0, 3),
      params: { ofActionId: state.throttle.actionId, automatic: true, runId: input.runId },
      hardLimit: false,
    })
  }

  if (ratio >= 1) {
    const signal = budgetSignalLike({
      runId: input.runId, ratio, now, code: 'budget_exhausted', severity: 'L4', threshold: 1, spent, limit,
    })
    plans.push(...plansFor({
      runId: input.runId, cases, config, state, signal, kind: 'abort', severity: 'L4', hardLimit: true, now,
      reason: `run budget exhausted (${formatPercent(ratio)} of ${limit} tokens); deterministic abort`,
    }, notices))
  } else if (ratio >= config.thresholds.budgetPause && config.policy.autopilot.pauseOnHardLimit !== false) {
    const signal = budgetSignalLike({
      runId: input.runId, ratio, now, code: 'budget_pause', severity: 'L3', threshold: config.thresholds.budgetPause, spent, limit,
    })
    if (status === 'running') {
      plans.push(...plansFor({
        runId: input.runId, cases, config, state, signal, kind: 'pause', severity: 'L3', hardLimit: true, now,
        reason: `run budget at ${formatPercent(ratio)} crossed the hard pause threshold ${formatPercent(config.thresholds.budgetPause)}; paused without automatic resume`,
      }, notices))
    } else {
      const record = safeFind(cases, signal)
      notices.push({
        code: 'hard_pause_skipped',
        reason: `budget hard pause threshold crossed while the run is ${status}`,
        caseId: record?.id,
      })
    }
  }

  const hasHardPlan = plans.some(plan => plan.kind === 'pause' || plan.kind === 'abort')
  if (ratio >= config.thresholds.budgetPressure
    && ratio < config.thresholds.budgetPause
    && config.policy.autopilot.throttle !== false
    && state.throttle === null
    && status === 'running'
    && !hasHardPlan) {
    const minutes = Math.max(1, Math.trunc(config.policy.throttleMinutes ?? 10))
    const signal = budgetSignalLike({
      runId: input.runId, ratio, now, code: 'budget_pressure', severity: 'L2', threshold: config.thresholds.budgetPressure, spent, limit,
    })
    plans.push(...plansFor({
      runId: input.runId, cases, config, state, signal, kind: 'throttle', severity: 'L2', hardLimit: false, now, minutes,
      reason: `run budget at ${formatPercent(ratio)} crossed the throttle threshold ${formatPercent(config.thresholds.budgetPressure)}; pausing for ${minutes} minute(s)`,
    }, notices))
  }

  plans.sort((a, b) => (PLAN_PRIORITY[b.kind] ?? 0) - (PLAN_PRIORITY[a.kind] ?? 0))
  return { plans: plans.slice(0, 2), notices }
}

/**
 * Turn one intended guard action into a plan, or explain why it cannot happen.
 * Hard stops still need a case and a write token: acting without either would be
 * an untraceable or impossible action.
 * @param {object} input
 * @param {Array<{ code: string, reason: string, caseId?: string }>} notices
 * @returns {GuardPlan[]}
 */
function plansFor(input, notices) {
  const { runId, cases, config, state, signal, kind, severity, reason, now } = input
  let record = null
  try {
    record = cases.ensure(signal, now)
  } catch (error) {
    notices.push({ code: 'case_error', reason: `could not open a case: ${messageOf(error)}` })
    return []
  }
  if (record === null) {
    notices.push({ code: 'no_case', reason: `guard could not open a case for ${signal.code}` })
    return []
  }
  if (config.http.token === '') {
    notices.push({ code: 'write_disabled', reason: 'http.token is empty, so the guard cannot act', caseId: record.id })
    return []
  }
  if (kind !== 'abort' && state.interventions >= config.policy.maxAutoInterventions) {
    notices.push({ code: 'auto_intervention_limit', reason: `auto intervention limit ${config.policy.maxAutoInterventions} reached`, caseId: record.id })
    return []
  }
  const last = state.lastActions.get(`${record.id}:${kind}`) ?? 0
  if (last !== 0 && now - last < config.policy.cooldownMs) {
    notices.push({ code: 'cooldown', reason: `${kind} already attempted for this case within the cooldown`, caseId: record.id })
    return []
  }
  /** @type {GuardPlan} */
  const plan = {
    kind,
    caseId: record.id,
    severity,
    reason,
    evidenceRefs: record.evidence.map(entry => String(entry.id)).slice(0, 4),
    params: kind === 'throttle' ? { minutes: input.minutes, runId } : { runId },
    hardLimit: input.hardLimit === true,
  }
  return [plan]
}

/** @param {import('./cases.js').CaseManager} cases @param {any} signal */
function safeFind(cases, signal) {
  try {
    return cases.findOpenBySignal(signal)
  } catch {
    return null
  }
}

/**
 * @param {{ runId: string, ratio: number, now: number, code: string, severity: string, threshold: number, spent: number, limit: number }} input
 * @returns {import('./signals.js').Signal}
 */
function budgetSignalLike(input) {
  return {
    code: input.code,
    severity: /** @type {any} */ (input.severity),
    summary: `run budget at ${formatPercent(input.ratio)} (threshold ${formatPercent(input.threshold)})`,
    suggestedAction: input.severity === 'L4' ? 'abort' : input.severity === 'L3' ? 'pause' : 'throttle',
    evidence: {
      id: evidenceId('swarm', 'budget', `run:${input.runId}:${input.code}`),
      source: 'swarm',
      kind: 'budget',
      at: new Date(input.now).toISOString(),
      ref: { runId: input.runId },
      observed: { scope: 'run', used: input.spent, limit: input.limit, ratio: input.ratio, threshold: input.threshold },
    },
  }
}

/** @param {number} ratio */
function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
