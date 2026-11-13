/**
 * Pure signal rules. No model, no I/O, no clock reads except the `now` passed in.
 *
 * A signal is evidence-backed: `evidence` is the object the policy engine later
 * checks a decision against. Codes are stable because the panel, the watch log,
 * and the tests all match on them.
 * @module dsh-overwatch/signals
 */

/** @typedef {'L1' | 'L2' | 'L3'} Severity */

/**
 * @typedef {object} Signal
 * @property {string} code stable code, e.g. `budget_pressure`
 * @property {Severity} severity
 * @property {string} summary short, human-readable, no untrusted prose
 * @property {string} suggestedAction
 * @property {{ id: string, source: string, kind: string, at: string, ref: unknown, observed: unknown }} evidence
 */

/**
 * Evidence id is deterministic per source + ref + observation bucket so a
 * repeated sample does not create a new evidence row.
 * @param {string} source
 * @param {string} kind
 * @param {string} bucket
 * @returns {string}
 */
export function evidenceId(source, kind, bucket) {
  return `ev_${source}_${kind}_${bucket}`
}

/**
 * Budget pressure, with the emergency threshold taking precedence.
 * @param {{ used: number, limit: number, scope?: string, ref?: unknown, at?: string }} input
 * @param {{ budgetPressure: number, budgetPause: number }} thresholds
 * @returns {Signal | null}
 */
export function budgetSignal(input, thresholds) {
  if (!Number.isFinite(input.limit) || input.limit <= 0) return null
  const used = Math.max(0, input.used)
  const ratio = used / input.limit
  const at = input.at ?? new Date(0).toISOString()
  const scope = input.scope ?? 'run'
  if (ratio >= thresholds.budgetPause) {
    return {
      code: 'budget_pause',
      severity: 'L3',
      summary: `${scope} budget at ${formatPercent(ratio)} — hard pause threshold`,
      suggestedAction: 'abort',
      evidence: {
        id: evidenceId('swarm', 'budget', `${scope}:${String(input.ref ?? '')}:pause`),
        source: 'swarm',
        kind: 'budget',
        at,
        ref: input.ref ?? null,
        observed: { scope, used, limit: input.limit, ratio, threshold: thresholds.budgetPause },
      },
    }
  }
  if (ratio >= thresholds.budgetPressure) {
    return {
      code: 'budget_pressure',
      severity: 'L2',
      summary: `${scope} budget at ${formatPercent(ratio)} — pressure threshold`,
      suggestedAction: 'throttle',
      evidence: {
        id: evidenceId('swarm', 'budget', `${scope}:${String(input.ref ?? '')}:pressure`),
        source: 'swarm',
        kind: 'budget',
        at,
        ref: input.ref ?? null,
        observed: { scope, used, limit: input.limit, ratio, threshold: thresholds.budgetPressure },
      },
    }
  }
  return null
}

/**
 * A streak of failed tool results, read from already-sampled counters.
 * @param {{ failures: number, lastFailureAt?: string, ref?: unknown }} input
 * @param {{ failureStreak: number }} thresholds
 * @returns {Signal | null}
 */
export function failureStreakSignal(input, thresholds) {
  if (input.failures < thresholds.failureStreak) return null
  const at = input.lastFailureAt ?? new Date(0).toISOString()
  return {
    code: 'failure_streak',
    severity: 'L2',
    summary: `${input.failures} consecutive tool failures (threshold ${thresholds.failureStreak})`,
    suggestedAction: 'coach',
    evidence: {
      id: evidenceId('swarm', 'failure_streak', String(input.ref ?? 'run')),
      source: 'swarm',
      kind: 'failure_streak',
      at,
      ref: input.ref ?? null,
      observed: { failures: input.failures, threshold: thresholds.failureStreak },
    },
  }
}

/**
 * A run that is still marked running but has produced no event for `stallMs`.
 * @param {{ status: string, lastEventAt: string, now: number, ref?: unknown }} input
 * @param {{ stallMs: number }} thresholds
 * @returns {Signal | null}
 */
export function stallSignal(input, thresholds) {
  if (!isActiveStatus(input.status)) return null
  const last = Date.parse(input.lastEventAt)
  if (!Number.isFinite(last)) return null
  const quietMs = input.now - last
  if (quietMs < thresholds.stallMs) return null
  return {
    code: 'stalled_dispatch',
    severity: 'L2',
    summary: `no event for ${Math.round(quietMs / 1000)}s (threshold ${Math.round(thresholds.stallMs / 1000)}s)`,
    suggestedAction: 'throttle',
    evidence: {
      id: evidenceId('swarm', 'stall', `${String(input.ref ?? 'run')}:${Math.floor(last / thresholds.stallMs)}`),
      source: 'swarm',
      kind: 'stall',
      at: new Date(input.now).toISOString(),
      ref: input.ref ?? null,
      observed: { status: input.status, lastEventAt: input.lastEventAt, quietMs, threshold: thresholds.stallMs },
    },
  }
}

/**
 * Context pressure from the official token meter, with exit hysteresis left to
 * the caller (this function only reports the entry signal).
 * @param {{ ratio: number, at?: string, sessionId?: string }} input
 * @param {{ contextPressure: number }} thresholds
 * @returns {Signal | null}
 */
export function contextPressureSignal(input, thresholds) {
  if (!Number.isFinite(input.ratio) || input.ratio < thresholds.contextPressure) return null
  const at = input.at ?? new Date(0).toISOString()
  return {
    code: 'context_pressure',
    severity: 'L2',
    summary: `context at ${formatPercent(input.ratio)} (threshold ${formatPercent(thresholds.contextPressure)})`,
    suggestedAction: 'coach',
    evidence: {
      id: evidenceId('pressure', 'context', `${input.sessionId ?? 'session'}:${Math.floor(input.ratio * 20)}`),
      source: 'pressure',
      kind: 'context',
      at,
      ref: { sessionId: input.sessionId ?? null },
      observed: { ratio: input.ratio, threshold: thresholds.contextPressure },
    },
  }
}

/**
 * Evaluate every rule against one sampled snapshot.
 * @param {object} snapshot
 * @param {{ budget?: { used: number, limit: number, scope?: string, ref?: unknown, at?: string }, failures?: number, lastFailureAt?: string, run?: { status: string, lastEventAt: string, ref?: unknown }, context?: { ratio: number, sessionId?: string, at?: string }, now: number }} input
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config
 * @returns {Signal[]}
 */
export function evaluateSnapshot(input, config) {
  /** @type {Signal[]} */
  const signals = []
  if (input.budget !== undefined) {
    const signal = budgetSignal(input.budget, config.thresholds)
    if (signal !== null) signals.push(signal)
  }
  if (input.failures !== undefined) {
    const signal = failureStreakSignal({ failures: input.failures, lastFailureAt: input.lastFailureAt }, config.thresholds)
    if (signal !== null) signals.push(signal)
  }
  if (input.run !== undefined) {
    const signal = stallSignal({ ...input.run, now: input.now }, config.thresholds)
    if (signal !== null) signals.push(signal)
  }
  if (input.context !== undefined) {
    const signal = contextPressureSignal(input.context, config.thresholds)
    if (signal !== null) signals.push(signal)
  }
  return signals
}

/** @param {string} status */
export function isActiveStatus(status) {
  return status === 'running' || status === 'dispatched' || status === 'reviewing'
}

/** @param {number} ratio */
function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}
