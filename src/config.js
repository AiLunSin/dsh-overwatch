/**
 * Configuration defaults and validation for dsh-overwatch.
 *
 * The profile patch may override any field by row id. Unknown keys are ignored
 * (they may belong to a newer bundle), but a known key with the wrong type or
 * an out-of-range value fails activation: a mis-typed budget is worse than a
 * loud startup error.
 * @module dsh-overwatch/config
 */

import { resolveDataDir } from './util.js'

/** @typedef {'observe' | 'guard' | 'supervised'} OverwatchMode */

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  mode: /** @type {OverwatchMode} */ ('guard'),
  supervisor: {
    enabled: true,
    provider: 'spawn',
    model: 'inherit',
    agentPreset: '',
    reserveRatio: 0.05,
    maxReserveTokens: 200_000,
    maxWakes: 30,
    maxWakesPerHour: 6,
    wakeTimeoutMs: 90_000,
    maxEvidenceBytes: 8_192,
    maxEvidenceCalls: 3,
    maxTokensPerWake: 20_000,
  },
  sampling: {
    swarmEventMs: 1_000,
    swarmSnapshotMs: 5_000,
    pressureMs: 3_000,
    fishMs: 15_000,
    staleMs: 30_000,
    requestTimeoutMs: 3_000,
    maxInflight: 4,
  },
  policy: {
    cooldownMs: 900_000,
    maxAutoInterventions: 5,
    twoSignalRule: true,
    throttleMinutes: 10,
    autopilot: {
      throttle: true,
      pause: false,
      pauseOnHardLimit: true,
      abortOnHardLimit: true,
      budgetAdjust: false,
      restore: false,
    },
  },
  thresholds: {
    contextPressure: 0.85,
    contextExit: 0.70,
    budgetPressure: 0.80,
    budgetPause: 0.95,
    failureStreak: 3,
    gateFailures: 3,
    conflictStorm: 3,
    stallMs: 600_000,
    reviewDeadlockMs: 900_000,
    maxResultTokens: 12_000,
    maxOpenCases: 20,
  },
  storage: {
    dataDir: '',
    retentionDays: 90,
    maxBytesPerRun: 52_428_800,
  },
  ports: {
    swarmToken: '',
    origin: '',
  },
  fish: {
    dataDir: '',
  },
  http: {
    enabled: true,
    token: '',
  },
})

const MODES = new Set(['observe', 'guard', 'supervised'])
const MODELS = new Set(['inherit', 'fast', 'strong'])

/**
 * Deep-merge a profile config over the defaults and validate it.
 * @param {unknown} raw
 * @param {{ resolveDir?: (storage: { dataDir?: string }) => string }} [options]
 * @returns {typeof DEFAULT_CONFIG & { dataDir: string }}
 */
export function resolveConfig(raw, options = {}) {
  const input = isPlainObject(raw) ? raw : {}
  const config = {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    mode: input.mode ?? DEFAULT_CONFIG.mode,
    supervisor: merge(DEFAULT_CONFIG.supervisor, input.supervisor),
    sampling: merge(DEFAULT_CONFIG.sampling, input.sampling),
    policy: {
      ...merge(DEFAULT_CONFIG.policy, omit(input.policy, 'autopilot')),
      autopilot: merge(DEFAULT_CONFIG.policy.autopilot, isPlainObject(input.policy) ? input.policy.autopilot : undefined),
    },
    thresholds: merge(DEFAULT_CONFIG.thresholds, input.thresholds),
    storage: merge(DEFAULT_CONFIG.storage, input.storage),
    ports: merge(DEFAULT_CONFIG.ports, input.ports),
    fish: merge(DEFAULT_CONFIG.fish, input.fish),
    http: merge(DEFAULT_CONFIG.http, input.http),
    dataDir: '',
  }

  assertBoolean(config, 'enabled')
  if (!MODES.has(config.mode)) fail(`mode must be one of ${[...MODES].join(', ')}`)
  if (!MODELS.has(config.supervisor.model)) fail(`supervisor.model must be one of ${[...MODELS].join(', ')}`)
  assertString(config.supervisor, 'provider')
  assertString(config.supervisor, 'agentPreset')

  assertNumber(config.supervisor, 'reserveRatio', 0, 0.5)
  assertInteger(config.supervisor, 'maxReserveTokens', 0)
  assertInteger(config.supervisor, 'maxWakes', 0)
  assertInteger(config.supervisor, 'maxWakesPerHour', 0)
  assertInteger(config.supervisor, 'wakeTimeoutMs', 1_000)
  assertInteger(config.supervisor, 'maxEvidenceBytes', 1_024)
  assertInteger(config.supervisor, 'maxEvidenceCalls', 1)
  assertInteger(config.supervisor, 'maxTokensPerWake', 1_000)

  for (const key of ['swarmEventMs', 'swarmSnapshotMs', 'pressureMs', 'fishMs', 'staleMs', 'requestTimeoutMs']) {
    assertInteger(config.sampling, key, 100)
  }
  assertInteger(config.sampling, 'maxInflight', 1)

  for (const key of ['cooldownMs', 'maxAutoInterventions']) assertInteger(config.policy, key, 0)
  assertInteger(config.policy, 'throttleMinutes', 1)
  if (config.policy.throttleMinutes > 60) fail('policy.throttleMinutes must be at most 60')
  assertBoolean(config.policy, 'twoSignalRule')
  for (const key of Object.keys(DEFAULT_CONFIG.policy.autopilot)) assertBoolean(config.policy.autopilot, key)

  for (const key of ['contextPressure', 'contextExit', 'budgetPressure', 'budgetPause']) {
    assertNumber(config.thresholds, key, 0, 1)
  }
  for (const key of ['failureStreak', 'gateFailures', 'conflictStorm', 'stallMs', 'reviewDeadlockMs', 'maxResultTokens', 'maxOpenCases']) {
    assertInteger(config.thresholds, key, 1)
  }
  if (config.thresholds.budgetPressure > config.thresholds.budgetPause) {
    fail('thresholds.budgetPressure must not exceed thresholds.budgetPause')
  }
  if (config.thresholds.contextExit > config.thresholds.contextPressure) {
    fail('thresholds.contextExit must not exceed thresholds.contextPressure')
  }

  assertString(config.storage, 'dataDir')
  assertInteger(config.storage, 'retentionDays', 1)
  assertInteger(config.storage, 'maxBytesPerRun', 1_024)

  assertString(config.ports, 'swarmToken')
  assertString(config.ports, 'origin')
  if (config.ports.origin !== '' && !/^https?:\/\/[^\s]+$/.test(config.ports.origin)) fail('ports.origin must be an http(s) origin or empty')
  assertString(config.fish, 'dataDir')
  assertBoolean(config.http, 'enabled')
  assertString(config.http, 'token')

  config.dataDir = (options.resolveDir ?? resolveDataDir)(config.storage)
  return Object.freeze(deepFreeze(config))
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {Record<string, unknown>} base @param {unknown} override */
function merge(base, override) {
  /** @type {Record<string, unknown>} */
  const out = { ...base }
  if (!isPlainObject(override)) return out
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(/** @type {Record<string, unknown>} */ (out[key]), value)
    else out[key] = value
  }
  return out
}

/** @param {unknown} value @param {string} key */
function omit(value, key) {
  if (!isPlainObject(value)) return undefined
  const out = { ...value }
  delete out[key]
  return out
}

/** @param {any} config @param {string} key */
function assertBoolean(config, key) {
  if (typeof config[key] !== 'boolean') fail(`${key} must be a boolean`)
}

/** @param {any} config @param {string} key */
function assertString(config, key) {
  if (typeof config[key] !== 'string') fail(`${key} must be a string`)
}

/** @param {any} config @param {string} key @param {number} min @param {number} [max] */
function assertNumber(config, key, min, max = Number.POSITIVE_INFINITY) {
  const value = config[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${key} must be a number between ${min} and ${max}`)
  }
}

/** @param {any} config @param {string} key @param {number} min */
function assertInteger(config, key, min) {
  const value = config[key]
  if (!Number.isSafeInteger(value) || value < min) fail(`${key} must be an integer >= ${min}`)
}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new TypeError(`[overwatch] invalid config: ${message}`)
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
