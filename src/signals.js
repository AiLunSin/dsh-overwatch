/**
 * Pure signal rules. No model, no I/O, no clock reads except the `now` passed in.
 *
 * A signal is evidence-backed: `evidence` is the object the policy engine later
 * checks a decision against. Codes are stable because the panel, the watch log,
 * and the tests all match on them.
 * @module dsh-overwatch/signals
 */

/** @typedef {'L0' | 'L1' | 'L2' | 'L3' | 'L4'} Severity */

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

/** Stable key for an evidence ref that may be a string or a plain object. @param {unknown} ref */
function refKey(ref) {
  if (ref === null || ref === undefined) return 'run'
  if (typeof ref === 'string' || typeof ref === 'number' || typeof ref === 'boolean') return String(ref)
  if (typeof ref === 'object') {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (ref))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    return entries.length === 0 ? 'run' : entries.join(',')
  }
  return String(ref)
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
  if (ratio >= 1) {
    return {
      code: 'budget_exhausted',
      severity: 'L4',
      summary: `${scope} budget exhausted at ${formatPercent(ratio)} — hard stop`,
      suggestedAction: 'abort',
      evidence: {
        id: evidenceId('swarm', 'budget', `${scope}:${refKey(input.ref)}:exhausted`),
        source: 'swarm',
        kind: 'budget',
        at,
        ref: input.ref ?? null,
        observed: { scope, used, limit: input.limit, ratio, threshold: 1 },
      },
    }
  }
  if (ratio >= thresholds.budgetPause) {
    return {
      code: 'budget_pause',
      severity: 'L3',
      summary: `${scope} budget at ${formatPercent(ratio)} — hard pause threshold`,
      suggestedAction: 'abort',
      evidence: {
        id: evidenceId('swarm', 'budget', `${scope}:${refKey(input.ref)}:pause`),
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
        id: evidenceId('swarm', 'budget', `${scope}:${refKey(input.ref)}:pressure`),
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
  const ref = input.ref
  const refKey = ref !== null && typeof ref === 'object'
    ? String(/** @type {Record<string, unknown>} */ (ref).memberId ?? /** @type {Record<string, unknown>} */ (ref).taskId ?? 'run')
    : String(ref ?? 'run')
  return {
    code: 'failure_streak',
    severity: 'L2',
    summary: `${input.failures} consecutive tool failures (threshold ${thresholds.failureStreak})`,
    suggestedAction: 'coach',
    evidence: {
      id: evidenceId('swarm', 'failure_streak', refKey),
      source: 'swarm',
      kind: 'failure_streak',
      at,
      ref: ref ?? null,
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
      id: evidenceId('swarm', 'stall', `${refKey(input.ref)}:${Math.floor(last / thresholds.stallMs)}`),
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
 * The swarm event stream stopped being contiguous. The guard treats this as an
 * integrity failure: it will not act on a stream it cannot trust.
 * @param {{ expectedSeq?: number, actualSeq?: number, at?: string, ref?: unknown }} input
 * @returns {Signal}
 */
export function eventGapSignal(input = {}) {
  const expected = Number.isInteger(input.expectedSeq) ? input.expectedSeq : null
  const actual = Number.isInteger(input.actualSeq) ? input.actualSeq : null
  return {
    code: 'log_integrity',
    severity: 'L4',
    summary: `swarm event sequence gap (expected ${String(expected)}, got ${String(actual)})`,
    suggestedAction: 'abort',
    evidence: {
      id: evidenceId('swarm', 'log_integrity', `${String(expected)}:${String(actual)}`),
      source: 'swarm',
      kind: 'log_integrity',
      at: input.at ?? new Date(0).toISOString(),
      ref: input.ref ?? null,
      observed: { expectedSeq: expected, actualSeq: actual },
    },
  }
}

/**
 * The swarm source has failed repeatedly. This is L2: it opens a case and
 * blocks model-driven actions until the source recovers; it is not an abort.
 * @param {{ source?: string, failures: number, error?: string | null, at?: string, ref?: unknown }} input
 * @param {number} [threshold]
 * @returns {Signal | null}
 */
export function sourceUnavailableSignal(input, threshold = 3) {
  if (!(input.failures >= threshold)) return null
  const source = input.source ?? 'swarm'
  const at = input.at ?? new Date(0).toISOString()
  return {
    code: 'source_unavailable',
    severity: 'L2',
    summary: `${source} source unavailable (${input.failures} consecutive failures)`,
    suggestedAction: 'escalate',
    evidence: {
      id: evidenceId('watch', 'source_unavailable', `${source}:${input.failures}`),
      source: 'watch',
      kind: 'source',
      at,
      ref: input.ref ?? { source },
      observed: { source, failures: input.failures, threshold, error: input.error ?? null },
    },
  }
}

/**
 * The same task keeps failing its gate. L2: stop re-dispatching and escalate,
 * but do not kill the run.
 * @param {{ taskId: string, failures: number, at?: string }} input
 * @param {{ gateFailures: number }} thresholds
 * @returns {Signal | null}
 */
export function gatePingpongSignal(input, thresholds) {
  if (input.failures < thresholds.gateFailures) return null
  return {
    code: 'gate_pingpong',
    severity: 'L2',
    summary: `task ${input.taskId} failed its gate ${input.failures} times (threshold ${thresholds.gateFailures})`,
    suggestedAction: 'escalate',
    evidence: {
      id: evidenceId('swarm', 'gate_pingpong', `${input.taskId}:${input.failures}`),
      source: 'swarm',
      kind: 'gate',
      at: input.at ?? new Date(0).toISOString(),
      ref: { taskId: input.taskId },
      observed: { taskId: input.taskId, failures: input.failures, threshold: thresholds.gateFailures },
    },
  }
}

/**
 * A review has been open longer than the deadlock window without quorum.
 * @param {{ patchId: string, taskId: string, ageMs: number, reviewers: number, votes: number, at?: string }} input
 * @param {{ reviewDeadlockMs: number }} thresholds
 * @returns {Signal | null}
 */
export function reviewDeadlockSignal(input, thresholds) {
  if (!(input.ageMs >= thresholds.reviewDeadlockMs)) return null
  if (input.votes >= input.reviewers) return null
  return {
    code: 'review_deadlock',
    severity: 'L2',
    summary: `review ${input.patchId} has been open ${Math.round(input.ageMs / 1000)}s (${input.votes}/${input.reviewers} votes)`,
    suggestedAction: 'escalate',
    evidence: {
      id: evidenceId('swarm', 'review_deadlock', `${input.patchId}:${Math.floor(input.ageMs / thresholds.reviewDeadlockMs)}`),
      source: 'swarm',
      kind: 'review',
      at: input.at ?? new Date(0).toISOString(),
      ref: { patchId: input.patchId, taskId: input.taskId },
      observed: { patchId: input.patchId, taskId: input.taskId, ageMs: input.ageMs, reviewers: input.reviewers, votes: input.votes, threshold: thresholds.reviewDeadlockMs },
    },
  }
}

/**
 * Several merge conflicts in one run. The guard cannot resolve them; it opens a
 * case so the run is visible and a human/watch officer can serialize the merge.
 * @param {{ count: number, files?: string[], at?: string }} input
 * @param {{ conflictStorm: number }} thresholds
 * @returns {Signal | null}
 */
export function conflictStormSignal(input, thresholds) {
  if (input.count < thresholds.conflictStorm) return null
  return {
    code: 'conflict_storm',
    severity: 'L2',
    summary: `${input.count} merge conflicts (threshold ${thresholds.conflictStorm})`,
    suggestedAction: 'escalate',
    evidence: {
      id: evidenceId('swarm', 'conflict_storm', `${input.count}:${(input.files ?? []).slice(0, 3).join(',')}`),
      source: 'swarm',
      kind: 'merge_conflict',
      at: input.at ?? new Date(0).toISOString(),
      ref: { files: (input.files ?? []).slice(0, 5) },
      observed: { count: input.count, files: (input.files ?? []).slice(0, 5), threshold: thresholds.conflictStorm },
    },
  }
}

/**
 * Evaluate every rule against one sampled snapshot.
 * @param {object} snapshot
 * @param {{ budget?: { used: number, limit: number, scope?: string, ref?: unknown, at?: string }, failures?: number, lastFailureAt?: string, run?: { status: string, lastEventAt: string, ref?: unknown }, context?: { ratio: number, sessionId?: string, at?: string }, eventGap?: { expectedSeq?: number, actualSeq?: number, at?: string, ref?: unknown }, now: number }} input
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config
 * @returns {Signal[]}
 */
export function evaluateSnapshot(input, config) {
  /** @type {Signal[]} */
  const signals = []
  if (input.eventGap !== undefined) signals.push(eventGapSignal(input.eventGap))
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
