/**
 * M1 real-host verification probe.
 *
 * This is test-only code installed into a throwaway profile. It drives the
 * real HTTP surface of the packaged DSH Web Host:
 *
 * 1. wait for `/overwatch/api/health` and the fake `/swarm/api/health`;
 * 2. exercise arm's token/origin contract, then arm `swarm_m1` in guard mode;
 * 3. drive the fake swarm budget to 0.81 (L2 case, no action), 0.96 (guard
 *    pause), and 1.01 (guard abort);
 * 4. disarm, prove the run snapshot is disarmed and every pending case was
 *    abandoned;
 * 5. read the watch log written by the real service from `OVERWATCH_M1_DATA`
 *    and independently verify its hash chain and action sequences.
 *
 * The report is written to `$OVERWATCH_M1_OUT` (or
 * `$DSH_HOME/overwatch-m1-report.json`) with `finishedAt` set last, so the
 * runner can treat a report with `finishedAt !== null` as complete.
 *
 * It never imports `dsh-overwatch` private modules and never modifies its
 * files: the HTTP surface and the published watch.jsonl are the only inputs.
 * @module dsh-overwatch-m1-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-overwatch-m1-probe'

/** No hard dependency: the Host services mount asynchronously. */
export const inject = []

const RUN_ID = 'swarm_m1'
const TOKEN = 'm1-token'
const EVIL_ORIGIN = 'https://evil.example'
const STAGE = process.env.OVERWATCH_M1_STAGE ?? 'web'
const OUT = process.env.OVERWATCH_M1_OUT ?? path.join(process.env.DSH_HOME ?? process.cwd(), 'overwatch-m1-report.json')
const DATA = process.env.OVERWATCH_M1_DATA ?? path.join(process.env.DSH_HOME ?? process.cwd(), 'overwatch')

const HEALTH_WAIT_MS = 20_000
const CASE_WAIT_MS = 15_000
const ACTION_WAIT_MS = 15_000
const WATCH_WAIT_MS = 5_000
const SAMPLING_SETTLE_MS = 1_200
const POLL_MS = 250

const REQUIRED_WATCH_TYPES = Object.freeze([
  'watch/armed',
  'watch/case/opened',
  'watch/action/intended',
  'watch/action/executed',
  'watch/action/verified',
  'watch/case/closed',
  'watch/disarmed',
])

const EXPECTED_CHECKS = Object.freeze([
  'health',
  'swarm-health',
  'arm-no-token',
  'arm-wrong-token',
  'arm-cross-origin',
  'arm-ok',
  'arm-duplicate',
  'budget-pressure-case',
  'budget-pressure-no-action',
  'budget-pause-case',
  'budget-pause-call',
  'budget-pause-run',
  'budget-pause-watch',
  'budget-exhausted-case',
  'budget-exhausted-call',
  'budget-exhausted-run',
  'budget-exhausted-watch',
  'disarm',
  'disarm-run',
  'disarm-cases',
  'disarm-again',
  'watch-chain',
  'watch-types',
  'watch-pause-chain',
  'watch-abort-chain',
])

const report = {
  schemaVersion: 1,
  stage: STAGE,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  env: {
    node: process.version,
    platform: process.platform,
    dshHome: process.env.DSH_HOME ?? null,
    dataDir: DATA,
  },
  checks: {},
  http: {},
  cases: [],
  watch: {
    path: null,
    chainOk: false,
    count: 0,
    lastHash: null,
    error: null,
    types: [],
    events: [],
  },
  errors: [],
}

for (const id of EXPECTED_CHECKS) {
  report.checks[id] = { status: 'blocked', evidence: { reason: 'not evaluated yet' }, at: new Date().toISOString() }
}

let origin = ''
let finished = false

/** Persist the report atomically so a reader never sees a half-written file. @returns {void} */
function save() {
  mkdirSync(path.dirname(OUT), { recursive: true })
  const temp = `${OUT}.${process.pid}.${Date.now()}.tmp`
  const text = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(temp, text, 'utf8')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(temp, OUT)
      return
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : ''
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 9) {
        // The runner polls this file every 250ms; on Windows a concurrent reader
        // can hold the destination open long enough to make rename fail. Fall
        // back to a direct write: the reader treats a torn JSON as "retry".
        try {
          writeFileSync(OUT, text, 'utf8')
        } catch {
          // best effort; the next tick retries
        }
        try {
          unlinkSync(temp)
        } catch {
          // already gone
        }
        return
      }
      const end = Date.now() + 20
      while (Date.now() < end) { /* short synchronous backoff */ }
    }
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** @param {unknown} value @param {number} [maxLength] */
function trim(value, maxLength = 1_500) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (text.length <= maxLength) return value
    return { truncated: true, bytes: text.length, preview: text.slice(0, maxLength) }
  } catch {
    return { unserializable: true }
  }
}

/**
 * Record one check and persist. A check is overwritten if it is evaluated
 * again, so a later successful poll can replace an earlier failed one.
 * @param {string} id
 * @param {'pass'|'fail'|'blocked'} status
 * @param {unknown} evidence
 */
function check(id, status, evidence) {
  report.checks[id] = { status, evidence: trim(evidence), at: new Date().toISOString() }
  save()
}

/** @param {string} id @param {unknown} evidence */
function pass(id, evidence) {
  check(id, 'pass', evidence)
}

/** @param {string} id @param {unknown} evidence */
function fail(id, evidence) {
  check(id, 'fail', evidence)
}

/** Finalize exactly once: `finishedAt` is the last field the runner observes. */
function finish() {
  if (finished) return
  finished = true
  const failed = Object.entries(report.checks)
    .filter(([, value]) => value.status !== 'pass')
    .map(([id]) => id)
  report.gate = { ok: failed.length === 0, failed, checkedAt: new Date().toISOString() }
  // Set `finishedAt` only after every check is final; the runner polls for it.
  // Re-adding the key also keeps it as the last JSON field, so a truncated or
  // hand-edited report cannot show a completion time without the checks before it.
  delete report.finishedAt
  report.finishedAt = new Date().toISOString()
  save()
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {{ token?: string, body?: unknown, originHeader?: string, timeoutMs?: number }} [options]
 */
async function tryFetch(method, pathname, options = {}) {
  if (origin === '') {
    return { method, path: pathname, status: 0, ok: false, body: null, error: 'webServer origin is unavailable' }
  }
  /** @type {Record<string, string>} */
  const headers = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token !== undefined) headers['x-overwatch-token'] = options.token
  if (options.originHeader !== undefined) headers.origin = options.originHeader
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    const text = await response.text()
    /** @type {unknown} */
    let body = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { method, path: pathname, status: response.status, ok: response.ok, body }
  } catch (error) {
    return { method, path: pathname, status: 0, ok: false, body: null, error: errorMessage(error) }
  }
}

/**
 * @param {string} id
 * @param {import('node:http').IncomingMessage['method'] & string} method
 * @param {string} pathname
 * @param {{ token?: string, body?: unknown, originHeader?: string, timeoutMs?: number }} options
 * @param {number | number[]} expected
 * @param {{ note?: string }} [meta]
 */
async function call(id, method, pathname, options, expected, meta = {}) {
  const result = await tryFetch(method, pathname, options)
  const expectedStatuses = Array.isArray(expected) ? expected : [expected]
  report.http[id] = {
    method,
    path: pathname,
    status: result.status,
    expected: expectedStatuses,
    ok: expectedStatuses.includes(result.status),
    tokenSent: options.token !== undefined,
    originHeader: options.originHeader ?? null,
    ...(meta.note === undefined ? {} : { note: meta.note }),
    at: new Date().toISOString(),
    ...(result.error === undefined ? {} : { error: result.error }),
    body: trim(result.body, 2_000),
  }
  save()
  return result
}

/** @template T @param {() => Promise<T | null>} predicate @param {number} timeoutMs @returns {Promise<T | null>} */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== null && value !== undefined && value !== false) return value
    await delay(POLL_MS)
  }
  return null
}

/** @template T @param {() => T | null} probe @param {number} timeoutMs @returns {Promise<T | null>} */
async function waitForValue(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== null && value !== undefined) return value
    await delay(100)
  }
  return null
}

/** @param {unknown} body */
function dataOf(body) {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    return /** @type {any} */ (body).data
  }
  return body
}

/** @param {unknown} body */
function casesOf(body) {
  const data = dataOf(body)
  if (data !== null && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).cases)) {
    return /** @type {any[]} */ (/** @type {any} */ (data).cases)
  }
  return []
}

/** @param {string} state */
function casesPath(state) {
  return `/overwatch/api/runs/${RUN_ID}/cases?state=${encodeURIComponent(state)}&limit=100`
}

/** @param {unknown} item */
function caseView(item) {
  const value = /** @type {any} */ (item)
  if (value === null || typeof value !== 'object') return value
  return {
    id: value.id,
    code: value.code,
    severity: value.severity,
    title: value.title,
    state: value.state,
    openedAt: value.openedAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt ?? null,
    closeReason: value.closeReason ?? null,
    signals: Array.isArray(value.signals)
      ? value.signals.map(signal => ({
          code: signal?.code,
          severity: signal?.severity,
          value: signal?.value,
          threshold: signal?.threshold,
          at: signal?.at,
        }))
      : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence.map(evidence => ({ id: evidence?.id, kind: evidence?.kind, source: evidence?.source, at: evidence?.at }))
      : [],
    actions: Array.isArray(value.actions)
      ? value.actions.map(action => ({ id: action?.id, kind: action?.kind, state: action?.state, at: action?.at }))
      : [],
  }
}

/** @param {string} phase @param {unknown} item */
function recordCase(phase, item) {
  const view = caseView(item)
  report.cases.push({
    phase,
    ...(view !== null && typeof view === 'object' ? view : {}),
    view,
    raw: trim(item, 4_000),
  })
  save()
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** @param {unknown} value */
function sortValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return value
  }
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const sorted = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue
      sorted[key] = sortValue(source[key])
    }
    return sorted
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

/** @param {string} prev @param {unknown} body */
function chainHash(prev, body) {
  return sha256(`${prev}\n${canonicalJson(body)}`)
}

/** Find `watch.jsonl` files under the evidence root without assuming one layout. @param {string} dir @param {number} [depth] @returns {string[]} */
function findWatchFiles(dir, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return []
  /** @type {string[]} */
  const files = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...findWatchFiles(full, depth + 1))
    else if (entry.isFile() && entry.name === 'watch.jsonl') files.push(full)
  }
  return files
}

/** Resolve the watch log: prefer the per-run path, then the M0 flat path, then the newest file. */
function resolveWatchFile() {
  const preferred = path.join(DATA, 'runs', RUN_ID, 'watch.jsonl')
  if (existsSync(preferred)) return preferred
  const flat = path.join(DATA, 'watch.jsonl')
  if (existsSync(flat)) return flat
  const files = findWatchFiles(DATA)
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return files[0] ?? preferred
}

/**
 * Read and verify the watch log. A torn final line while the service is still
 * writing is reported as a chain error and retried by `waitForWatch`.
 * @returns {{ path: string, exists: boolean, events: any[], chain: { ok: boolean, count: number, lastHash: string | null, error: string | null } }}
 */
function readWatch() {
  const file = resolveWatchFile()
  const missing = { path: file, exists: false, events: [], chain: { ok: false, count: 0, lastHash: null, error: 'watch.jsonl not found' } }
  if (!existsSync(file)) return missing
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { path: file, exists: true, events: [], chain: { ok: false, count: 0, lastHash: null, error: errorMessage(error) } }
  }
  /** @type {any[]} */
  const events = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      return {
        path: file,
        exists: true,
        events,
        chain: { ok: false, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: `line ${index + 1}: ${errorMessage(error)}` },
      }
    }
  }
  let prev = 'genesis'
  let expectedSeq = 1
  for (const event of events) {
    if (event?.v !== 1) {
      return { path: file, exists: true, events, chain: { ok: false, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: `event ${String(event?.seq)}: v is not 1` } }
    }
    if (event.seq !== expectedSeq) {
      return { path: file, exists: true, events, chain: { ok: false, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: `expected seq ${expectedSeq}, got ${String(event.seq)}` } }
    }
    if (event.prev !== prev) {
      return { path: file, exists: true, events, chain: { ok: false, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: `event ${event.seq}: prev does not match` } }
    }
    const { hash, ...body } = event
    if (hash !== chainHash(prev, body)) {
      return { path: file, exists: true, events, chain: { ok: false, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: `event ${event.seq}: hash does not match` } }
    }
    prev = hash
    expectedSeq += 1
  }
  return {
    path: file,
    exists: true,
    events,
    chain: { ok: true, count: events.length, lastHash: events.at(-1)?.hash ?? null, error: null },
  }
}

/** @param {any[]} events @param {string} kind */
function actionChain(events, kind) {
  const actionTypes = new Set(['watch/action/intended', 'watch/action/executed', 'watch/action/verified', 'watch/action/failed', 'watch/action/unverified'])
  const intended = events.find(event => event.type === 'watch/action/intended' && event.payload?.kind === kind)
  const executed = intended === undefined
    ? undefined
    : events.find(event => event.type === 'watch/action/executed' && event.payload?.kind === kind && event.seq > intended.seq)
  const verified = executed === undefined
    ? undefined
    : events.find(event => event.type === 'watch/action/verified' && event.payload?.kind === kind && event.seq > executed.seq && event.payload?.ok !== false)
  const relevant = events.filter(event => actionTypes.has(event.type) && event.payload?.kind === kind)
  return {
    kind,
    ok: intended !== undefined && executed !== undefined && verified !== undefined,
    intended: intended === undefined ? null : { seq: intended.seq, type: intended.type, at: intended.at },
    executed: executed === undefined ? null : { seq: executed.seq, type: executed.type, at: executed.at },
    verified: verified === undefined ? null : { seq: verified.seq, type: verified.type, at: verified.at },
    events: relevant.map(event => ({ seq: event.seq, type: event.type, at: event.at, payload: trim(event.payload, 500) })),
  }
}

/** @param {string} label @param {(snapshot: ReturnType<typeof readWatch>) => unknown} predicate @returns {Promise<ReturnType<typeof readWatch> | null>} */
async function waitForWatch(label, predicate) {
  return waitFor(async () => {
    const snapshot = readWatch()
    if (!snapshot.chain.ok) return null
    return predicate(snapshot) ? snapshot : null
  }, WATCH_WAIT_MS)
}

/** @param {ReturnType<typeof readWatch>} snapshot */
function watchEvidence(snapshot) {
  return {
    path: snapshot.path,
    chain: snapshot.chain,
    types: snapshot.events.map(event => String(event.type)),
  }
}

/**
 * Wait for one HTTP endpoint to become ready. A plugin row may mount before
 * the Host service that owns the route; 404 and connection errors are retried.
 * @param {string} pathname
 * @param {(body: unknown) => boolean} accept
 * @param {number} timeoutMs
 */
async function waitForEndpoint(pathname, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await tryFetch('GET', pathname)
    if (last.status === 200 && accept(last.body)) return last
    await delay(POLL_MS)
  }
  return last
}

/**
 * @param {string} pathname
 * @param {(body: unknown) => boolean} accept
 * @param {string} id
 * @param {number} timeoutMs
 */
async function healthCheck(pathname, accept, id, timeoutMs) {
  const result = await waitForEndpoint(pathname, accept, timeoutMs)
  report.http[id] = {
    method: 'GET',
    path: pathname,
    status: result?.status ?? 0,
    expected: [200],
    ok: result?.status === 200 && accept(result.body),
    tokenSent: false,
    originHeader: null,
    at: new Date().toISOString(),
    body: trim(result?.body ?? null, 2_000),
    ...(result?.error === undefined ? {} : { error: result.error }),
  }
  if (result?.status === 200 && accept(result.body)) pass(id, { status: result.status, body: trim(result.body) })
  else fail(id, { status: result?.status ?? 0, body: trim(result?.body ?? null), error: result?.error ?? null })
  save()
  return result?.status === 200 && accept(result.body)
}

/** Arm checks: the security rejections come before the one successful arm. */
async function armChecks() {
  const armPath = `/overwatch/api/runs/${RUN_ID}/arm`
  const noToken = await call('arm-no-token', 'POST', armPath, { body: { mode: 'guard' } }, 401, { note: 'no token' })
  if (noToken.status === 401) pass('arm-no-token', { status: noToken.status, body: trim(noToken.body) })
  else fail('arm-no-token', { status: noToken.status, body: trim(noToken.body) })

  const wrongToken = await call('arm-wrong-token', 'POST', armPath, { token: 'wrong-token', body: { mode: 'guard' } }, 401, { note: 'wrong token value' })
  if (wrongToken.status === 401) pass('arm-wrong-token', { status: wrongToken.status, body: trim(wrongToken.body) })
  else fail('arm-wrong-token', { status: wrongToken.status, body: trim(wrongToken.body) })

  const crossOrigin = await call('arm-cross-origin', 'POST', armPath, {
    token: TOKEN,
    originHeader: EVIL_ORIGIN,
    body: { mode: 'guard' },
  }, 403, { note: 'cross-origin write with the correct token' })
  if (crossOrigin.status === 403) pass('arm-cross-origin', { status: crossOrigin.status, body: trim(crossOrigin.body) })
  else fail('arm-cross-origin', { status: crossOrigin.status, body: trim(crossOrigin.body) })

  const armed = await call('arm-ok', 'POST', armPath, { token: TOKEN, body: { mode: 'guard' }, timeoutMs: 20_000 }, 200, { note: 'same-origin, correct token' })
  const armedData = dataOf(armed.body)
  const armOk = armed.status === 200
    && /** @type {any} */ (armed.body)?.ok === true
    && /** @type {any} */ (armedData)?.armed === true
    && /** @type {any} */ (armedData)?.mode === 'guard'
  if (armOk) pass('arm-ok', { status: armed.status, data: trim(armedData) })
  else fail('arm-ok', { status: armed.status, body: trim(armed.body) })

  const duplicate = await call('arm-duplicate', 'POST', armPath, { token: TOKEN, body: { mode: 'guard' } }, 409, { note: 'second arm on the same run' })
  if (duplicate.status === 409) pass('arm-duplicate', { status: duplicate.status, body: trim(duplicate.body) })
  else fail('arm-duplicate', { status: duplicate.status, body: trim(duplicate.body) })

  return armOk
}

/** @param {number} ratio @param {string} id */
async function setBudget(ratio, id) {
  const result = await call(id, 'POST', '/fake/api/budget', { body: { ratio } }, 200, { note: `fake swarm budget ratio ${ratio}` })
  if (result.status !== 200) report.errors.push(`fake budget ${ratio} returned ${result.status}: ${JSON.stringify(trim(result.body, 500))}`)
  return result
}

/** L2: a case is opened but autopilot.throttle=false means no action is taken. */
async function pressureChecks() {
  await setBudget(0.81, 'fake-budget-l2')
  await delay(SAMPLING_SETTLE_MS)
  const found = await waitFor(async () => {
    const result = await tryFetch('GET', casesPath('all'))
    if (result.status !== 200) return null
    return casesOf(result.body).find(item => item?.code === 'budget_pressure' && item?.severity === 'L2') ?? null
  }, CASE_WAIT_MS)
  if (found === null) {
    fail('budget-pressure-case', { ratio: 0.81, cases: trim(casesOf((await tryFetch('GET', casesPath('all'))).body)) })
    fail('budget-pressure-no-action', { reason: 'no budget_pressure case to compare' })
    return
  }
  recordCase('L2', found)
  pass('budget-pressure-case', { case: caseView(found), ratio: 0.81 })

  await delay(SAMPLING_SETTLE_MS)
  const fake = await tryFetch('GET', '/fake/api/state')
  const watch = readWatch()
  const calls = Array.isArray(/** @type {any} */ (fake.body)?.calls) ? /** @type {any[]} */ (/** @type {any} */ (fake.body).calls) : []
  const intendedActions = watch.events.filter(event => event.type === 'watch/action/intended')
  const caseActions = Array.isArray(/** @type {any} */ (found).actions) ? /** @type {any[]} */ (/** @type {any} */ (found).actions) : []
  const mutatingKinds = new Set(['throttle', 'steer', 'pause', 'abort'])
  const actionEvidence = {
    fakeCalls: calls.map(item => ({ action: item?.action, httpStatus: item?.httpStatus })),
    watchActionEvents: intendedActions.map(event => ({ seq: event.seq, type: event.type, payload: trim(event.payload, 500) })),
    caseActions: caseActions.map(action => ({ kind: action?.kind, state: action?.state })),
  }
  const noAction = calls.every(item => !mutatingKinds.has(String(item?.action)))
    && intendedActions.length === 0
    && caseActions.every(action => !mutatingKinds.has(String(action?.kind)))
  if (noAction) pass('budget-pressure-no-action', actionEvidence)
  else fail('budget-pressure-no-action', actionEvidence)
}

/** L3: the guard pauses the fake run, and the action is verified in the watch chain. */
async function pauseChecks() {
  await setBudget(0.96, 'fake-budget-l3')
  await delay(SAMPLING_SETTLE_MS)
  const found = await waitFor(async () => {
    const result = await tryFetch('GET', casesPath('all'))
    if (result.status !== 200) return null
    return casesOf(result.body).find(item => item?.code === 'budget_pause' && item?.severity === 'L3') ?? null
  }, CASE_WAIT_MS)
  if (found === null) fail('budget-pause-case', { ratio: 0.96, cases: trim(casesOf((await tryFetch('GET', casesPath('all'))).body)) })
  else {
    recordCase('L3', found)
    pass('budget-pause-case', { case: caseView(found), ratio: 0.96 })
  }

  const pauseCall = await waitFor(async () => {
    const result = await tryFetch('GET', '/fake/api/state')
    if (result.status !== 200) return null
    const calls = Array.isArray(/** @type {any} */ (result.body)?.calls) ? /** @type {any[]} */ (/** @type {any} */ (result.body).calls) : []
    return calls.find(item => item?.action === 'pause' && item?.ok === true && item?.httpStatus === 200) ?? null
  }, ACTION_WAIT_MS)
  if (pauseCall === null) fail('budget-pause-call', { reason: 'fake swarm never received pause', fakeState: trim((await tryFetch('GET', '/fake/api/state')).body) })
  else pass('budget-pause-call', { call: trim(pauseCall), fakeState: trim((await tryFetch('GET', '/fake/api/state')).body) })

  const pausedRun = await waitFor(async () => {
    const result = await tryFetch('GET', `/overwatch/api/runs/${RUN_ID}`)
    if (result.status !== 200) return null
    const data = /** @type {any} */ (dataOf(result.body))
    const status = data?.status ?? data?.snapshot?.status
    return status === 'paused' ? { httpStatus: result.status, data } : null
  }, ACTION_WAIT_MS)
  if (pausedRun === null) fail('budget-pause-run', { reason: 'run snapshot never became paused', snapshot: trim(dataOf((await tryFetch('GET', `/overwatch/api/runs/${RUN_ID}`)).body)) })
  else pass('budget-pause-run', { httpStatus: pausedRun.httpStatus, status: pausedRun.data?.status, snapshotStatus: pausedRun.data?.snapshot?.status })

  const watch = await waitForWatch('pause action chain', snapshot => actionChain(snapshot.events, 'pause').ok)
  if (watch === null) fail('budget-pause-watch', { reason: 'pause intended/executed/verified missing or chain invalid', watch: trim(watchEvidence(readWatch())) })
  else pass('budget-pause-watch', { chain: actionChain(watch.events, 'pause'), watch: watchEvidence(watch) })
}

/** L4: the guard aborts the fake run and the abort is verified in the watch chain. */
async function exhaustChecks() {
  await setBudget(1.01, 'fake-budget-l4')
  await delay(SAMPLING_SETTLE_MS)
  const found = await waitFor(async () => {
    const result = await tryFetch('GET', casesPath('all'))
    if (result.status !== 200) return null
    return casesOf(result.body).find(item => item?.code === 'budget_exhausted' && item?.severity === 'L4') ?? null
  }, CASE_WAIT_MS)
  if (found === null) fail('budget-exhausted-case', { ratio: 1.01, cases: trim(casesOf((await tryFetch('GET', casesPath('all'))).body)) })
  else {
    recordCase('L4', found)
    pass('budget-exhausted-case', { case: caseView(found), ratio: 1.01 })
  }

  const abortCall = await waitFor(async () => {
    const result = await tryFetch('GET', '/fake/api/state')
    if (result.status !== 200) return null
    const calls = Array.isArray(/** @type {any} */ (result.body)?.calls) ? /** @type {any[]} */ (/** @type {any} */ (result.body).calls) : []
    return calls.find(item => item?.action === 'abort' && item?.ok === true && item?.httpStatus === 200) ?? null
  }, ACTION_WAIT_MS)
  if (abortCall === null) fail('budget-exhausted-call', { reason: 'fake swarm never received abort', fakeState: trim((await tryFetch('GET', '/fake/api/state')).body) })
  else pass('budget-exhausted-call', { call: trim(abortCall), fakeState: trim((await tryFetch('GET', '/fake/api/state')).body) })

  const abortedRun = await waitFor(async () => {
    const result = await tryFetch('GET', `/overwatch/api/runs/${RUN_ID}`)
    if (result.status !== 200) return null
    const data = /** @type {any} */ (dataOf(result.body))
    const status = data?.status ?? data?.snapshot?.status
    return status === 'aborted' ? { httpStatus: result.status, data } : null
  }, ACTION_WAIT_MS)
  if (abortedRun === null) fail('budget-exhausted-run', { reason: 'run snapshot never became aborted', snapshot: trim(dataOf((await tryFetch('GET', `/overwatch/api/runs/${RUN_ID}`)).body)) })
  else pass('budget-exhausted-run', { httpStatus: abortedRun.httpStatus, status: abortedRun.data?.status, snapshotStatus: abortedRun.data?.snapshot?.status })

  const watch = await waitForWatch('abort action chain', snapshot => actionChain(snapshot.events, 'abort').ok)
  if (watch === null) fail('budget-exhausted-watch', { reason: 'abort intended/executed/verified missing or chain invalid', watch: trim(watchEvidence(readWatch())) })
  else pass('budget-exhausted-watch', { chain: actionChain(watch.events, 'abort'), watch: watchEvidence(watch) })
}

/** Disarm: pending cases must be abandoned, the historical snapshot must stay readable. */
async function disarmChecks() {
  const before = await tryFetch('GET', casesPath('all'))
  const beforeCases = casesOf(before.body)
  const pendingIds = beforeCases.filter(item => item?.state !== 'closed').map(item => String(item.id))
  report.http['cases-before-disarm'] = {
    method: 'GET',
    path: casesPath('all'),
    status: before.status,
    expected: [200],
    ok: before.status === 200,
    at: new Date().toISOString(),
    body: trim(beforeCases.map(caseView), 4_000),
  }

  const disarm = await call('disarm', 'POST', `/overwatch/api/runs/${RUN_ID}/disarm`, { token: TOKEN, body: { reason: 'e2e' }, timeoutMs: 10_000 }, 200)
  const disarmData = /** @type {any} */ (dataOf(disarm.body))
  // M1 returns { runId, closedCases, disarmedAt }; accept an explicit state
  // too so the probe keeps working if the response grows a state field.
  const disarmOk = disarm.status === 200
    && disarmData?.runId === RUN_ID
    && Array.isArray(disarmData?.closedCases)
    && (disarmData?.state === undefined || disarmData?.state === 'disarmed')
  if (disarmOk) pass('disarm', { status: disarm.status, data: trim(disarmData) })
  else fail('disarm', { status: disarm.status, body: trim(disarm.body) })

  const snapshot = await call('disarm-run', 'GET', `/overwatch/api/runs/${RUN_ID}`, {}, 200)
  const snapshotData = /** @type {any} */ (dataOf(snapshot.body))
  const disarmedAt = snapshotData?.disarmedAt ?? null
  const snapshotOk = snapshot.status === 200
    && snapshotData?.armed === false
    && snapshotData?.state === 'disarmed'
    && disarmedAt !== null
    && disarmedAt !== ''
  if (snapshotOk) pass('disarm-run', { status: snapshot.status, armed: snapshotData?.armed, state: snapshotData?.state, disarmedAt })
  else fail('disarm-run', { status: snapshot.status, data: trim(snapshotData), body: trim(snapshot.body) })

  const after = await tryFetch('GET', casesPath('all'))
  const afterCases = casesOf(after.body)
  report.http['cases-after-disarm'] = {
    method: 'GET',
    path: casesPath('all'),
    status: after.status,
    expected: [200],
    ok: after.status === 200,
    at: new Date().toISOString(),
    body: trim(afterCases.map(caseView), 4_000),
  }
  const closedCases = Array.isArray(disarmData?.closedCases) ? disarmData.closedCases.map(String) : []
  const missing = pendingIds.filter(id => {
    const item = afterCases.find(candidate => String(candidate?.id) === id)
    return item === undefined || item.state !== 'closed' || item.closeReason !== 'abandoned'
  })
  const uncovered = pendingIds.filter(id => !closedCases.includes(id))
  const pendingOk = before.status === 200 && after.status === 200 && missing.length === 0 && uncovered.length === 0
  const pendingEvidence = {
    beforeStatus: before.status,
    afterStatus: after.status,
    pending: pendingIds,
    closedCases,
    missingOrNotAbandoned: missing,
    notListedByDisarm: uncovered,
    after: afterCases.map(caseView),
  }
  if (pendingIds.length === 0) {
    if (before.status === 200 && after.status === 200) pass('disarm-cases', { ...pendingEvidence, note: 'no open case remained at disarm time' })
    else fail('disarm-cases', pendingEvidence)
  } else if (pendingOk) pass('disarm-cases', pendingEvidence)
  else fail('disarm-cases', pendingEvidence)

  const again = await call('disarm-again', 'POST', `/overwatch/api/runs/${RUN_ID}/disarm`, { token: TOKEN, body: { reason: 'e2e-again' } }, [404, 409], { note: 'second disarm may be 404 or 409' })
  if (again.status === 404 || again.status === 409) pass('disarm-again', { status: again.status, body: trim(again.body) })
  else fail('disarm-again', { status: again.status, body: trim(again.body) })
}

/** Final watch-log verification: chain, required event types, and action order. */
async function finalWatchChecks() {
  const snapshot = await waitFor(async () => {
    const current = readWatch()
    if (!current.chain.ok) return null
    const missing = REQUIRED_WATCH_TYPES.filter(type => !current.events.some(event => event.type === type))
    return missing.length === 0 ? current : null
  }, WATCH_WAIT_MS) ?? readWatch()

  report.watch = {
    path: snapshot.path,
    chainOk: snapshot.chain.ok,
    count: snapshot.chain.count,
    lastHash: snapshot.chain.lastHash,
    error: snapshot.chain.error,
    types: snapshot.events.map(event => String(event.type)),
    events: snapshot.events.map(event => ({
      seq: event.seq,
      type: event.type,
      at: event.at,
      actor: event.actor,
      payload: trim(event.payload, 1_000),
    })),
  }
  save()

  if (snapshot.chain.ok) pass('watch-chain', { path: snapshot.path, count: snapshot.chain.count, lastHash: snapshot.chain.lastHash })
  else fail('watch-chain', { path: snapshot.path, error: snapshot.chain.error, count: snapshot.chain.count })

  const missing = REQUIRED_WATCH_TYPES.filter(type => !snapshot.events.some(event => event.type === type))
  if (missing.length === 0) pass('watch-types', { types: report.watch.types })
  else fail('watch-types', { missing, types: report.watch.types })

  const pause = actionChain(snapshot.events, 'pause')
  if (pause.ok && snapshot.chain.ok) pass('watch-pause-chain', pause)
  else fail('watch-pause-chain', { ...pause, chainOk: snapshot.chain.ok })

  const abort = actionChain(snapshot.events, 'abort')
  if (abort.ok && snapshot.chain.ok) pass('watch-abort-chain', abort)
  else fail('watch-abort-chain', { ...abort, chainOk: snapshot.chain.ok })
}

/** Run the whole scenario. Throwing here is caught by `apply` and recorded as fatal. */
async function runScenario(webOrigin) {
  origin = webOrigin.replace(/\/$/, '')
  report.env.origin = origin
  save()

  const health = await healthCheck('/overwatch/api/health', body => body !== null && typeof body === 'object' && /** @type {any} */ (body).ok === true, 'health', HEALTH_WAIT_MS)
  const swarmHealth = await healthCheck('/swarm/api/health', body => body !== null && typeof body === 'object' && /** @type {any} */ (body).ok === true && /** @type {any} */ (body).runs === 1, 'swarm-health', HEALTH_WAIT_MS)
  if (!health || !swarmHealth) {
    report.errors.push('required health endpoint did not become ready within 20s')
    return
  }

  const armed = await armChecks()
  if (!armed) {
    report.errors.push('arm failed; budget/pause/abort phases were skipped')
    await disarmChecks()
    await finalWatchChecks()
    return
  }

  await pressureChecks()
  await pauseChecks()
  await exhaustChecks()
  await disarmChecks()
  await finalWatchChecks()
}

/**
 * @param {any} ctx Cordis Host context
 */
export function apply(ctx) {
  save()
  const run = async () => {
    const webServer = await waitForValue(() => {
      try {
        const server = ctx.get?.('webServer')
        if (server === undefined || server === null) return null
        const value = typeof server.getOrigin === 'function' ? server.getOrigin() : null
        if (typeof value !== 'string' || value === '') return null
        return { server, origin: value }
      } catch (error) {
        report.errors.push(`webServer probe: ${errorMessage(error)}`)
        return null
      }
    }, 20_000)
    if (webServer === null) {
      fail('health', { reason: 'webServer origin never became available' })
      report.errors.push('webServer origin never became available')
      return
    }
    await runScenario(webServer.origin)
  }
  void run()
    .catch(error => {
      report.errors.push(`probe: ${errorMessage(error)}`)
    })
    .finally(() => {
      finish()
      ctx.logger?.info?.(`[m1-probe] finished: ${OUT}`)
    })
  ctx.logger?.info?.('[m1-probe] scheduled M1 HTTP checks')
}
