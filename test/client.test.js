import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const TOKEN_KEY = 'dsh-overwatch.write-token'

function loadDefinition() {
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.notEqual(definition, null, 'client.js must call window.__ModuleLoader__.load()')
  return { definition, sandbox }
}

function loadPlugin(definition) {
  const react = {
    createElement() {
      return null
    },
    useEffect() {},
    useRef() {
      return { current: null }
    },
    useState() {
      return [undefined, () => {}]
    },
  }
  const plugin = definition.factory((id) => {
    assert.equal(id, 'react', 'the factory only requires react')
    return react
  })
  const dictionaries = []
  const slots = []
  let dictionary = null
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict })
        dictionary = dict
        return () => {}
      },
      bind(namespace) {
        assert.equal(namespace, 'dshOverwatch')
        return (key, params) => {
          let text = dictionary?.zh?.[key] ?? key
          if (params !== undefined && params !== null && typeof text === 'string') {
            for (const [name, value] of Object.entries(params)) {
              text = text.split(`{${name}}`).join(String(value))
            }
          }
          return text
        }
      },
      subscribe() {
        return () => {}
      },
      getLocale() {
        return { active: 'zh' }
      },
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { plugin, dictionaries, slots }
}

const loadedDefinition = loadDefinition()
const definition = loadedDefinition.definition
const sandbox = loadedDefinition.sandbox
const loaded = loadPlugin(definition)
const dictionary = loaded.dictionaries[0]?.dict

function keysOf(locale) {
  return new Set(Object.keys(dictionary?.[locale] ?? {}))
}

function placeholders(text) {
  return Array.from(String(text).matchAll(/\{([A-Za-z0-9_.]+)\}/g)).map((match) => match[1]).sort()
}

test('registers a dsh-overwatch dynamic module with react only', () => {
  assert.equal(definition.id, 'dsh-overwatch')
  assert.equal(typeof definition.factory, 'function')
  assert.deepEqual(Array.from(loaded.plugin.inject), ['slots', 'locale'])
})

test('registers exactly the requested sidebar and main slots', () => {
  const sidebar = loaded.slots.find((entry) => entry.options.name === 'sidebar.panellist')
  const main = loaded.slots.find((entry) => entry.options.name === 'main')
  assert.notEqual(sidebar, undefined, 'sidebar.panellist must be registered')
  assert.notEqual(main, undefined, 'main must be registered')
  assert.equal(sidebar.options.id, 'overwatch')
  assert.equal(sidebar.options.order, 40)
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), '瞭望塔')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(main.options.key, 'overwatch')
  assert.equal(typeof main.component, 'function')
})

test('registers the dshOverwatch namespace with complete zh/en dictionaries', () => {
  assert.equal(loaded.dictionaries.length, 1)
  assert.equal(loaded.dictionaries[0].namespace, 'dshOverwatch')
  assert.notEqual(dictionary, null)
  const zh = keysOf('zh')
  const en = keysOf('en')
  assert.ok(zh.size > 100, 'zh dictionary should be substantial')
  assert.equal(zh.size, en.size, 'zh and en must expose the same keys')
  for (const key of zh) assert.ok(en.has(key), `en dictionary is missing ${key}`)
  for (const key of zh) {
    assert.equal(typeof dictionary.zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof dictionary.en[key], 'string', `en.${key} must be a string`)
    assert.ok(dictionary.zh[key].length > 0, `zh.${key} must not be empty`)
    assert.ok(dictionary.en[key].length > 0, `en.${key} must not be empty`)
    assert.deepEqual(placeholders(dictionary.en[key]), placeholders(dictionary.zh[key]), `placeholder mismatch for ${key}`)
  }
})

test('covers panel, tab, table, button, empty, error, fish, replay, and doctor copy', () => {
  const required = [
    'navLabel',
    'pageTitle',
    'guardOnlyBanner',
    'guardOnlyHint',
    'tabRoom',
    'tabCases',
    'tabFish',
    'tabReplay',
    'filterOpen',
    'filterAll',
    'colSeverity',
    'colTime',
    'colCode',
    'colTitle',
    'colState',
    'emptyTitle',
    'emptyBody',
    'emptyToolBody',
    'emptyHttpBody',
    'ack',
    'ackNote',
    'arm',
    'disarm',
    'tokenLabel',
    'tokenSave',
    'tokenSessionHint',
    'readOnlyBadge',
    'budget',
    'budgetThresholds',
    'freshness',
    'source.swarm',
    'source.pressure',
    'source.fish',
    'source.watch',
    'fresh.ok',
    'fresh.stale',
    'fresh.unavailable',
    'recentEvents',
    'integrity',
    'watchLog',
    'lockState',
    'lockNotReported',
    'casesTitle',
    'caseDetail',
    'signals',
    'evidence',
    'actions',
    'closeReason',
    'loading',
    'retry',
    'errorUnauthorized',
    'errorForbidden',
    'errorNotFound',
    'errorConflict',
    'fishTitle',
    'fishHostIndex',
    'fishIndexAvailable',
    'fishIndexPartial',
    'fishIndexMissing',
    'fishBrowser',
    'fishBrowserAvailable',
    'fishBrowserIndexOnly',
    'fishBrowserUnauthorized',
    'fishBrowserNotFound',
    'fishBrowserNetwork',
    'fishCheckpoints',
    'fishAudit',
    'fishTrigger',
    'fishPinned',
    'fishRestoreAction',
    'fishRestoreTitle',
    'fishRestorePreflight',
    'fishRestoreExecute',
    'fishRestoreOverride',
    'fishRestoreSafety',
    'fishRestoreSafetyCheckpoint',
    'fishRestoreSafetyGit',
    'fishRestoreIntentFailed',
    'fishRestoreResultTitle',
    'fishRestoreRecorded',
    'fishRestoreNeedRun',
    'fishRestoreNeedToken',
    'replayTitle',
    'replayLegend',
    'replayEvents',
    'replayLoadMore',
    'replayEmpty',
    'replayAutoHint',
    'doctorTitle',
    'doctorStatus.pass',
    'doctorStatus.warn',
    'doctorStatus.fail',
    'trigger.baseline',
    'trigger.pre-restore',
    'auditAction.restore',
    'auditResult.failed',
  ]
  for (const key of required) assert.ok(keysOf('zh').has(key), `missing i18n key ${key}`)
  assert.match(dictionary.zh.guardOnlyBanner, /guard-only/)
  assert.match(dictionary.zh.supervisedHint, /M2/)
  assert.match(dictionary.en.guardOnlyBanner, /guard-only/)
  assert.match(dictionary.en.supervisedHint, /M2/)
  assert.match(dictionary.zh.emptyToolBody, /watch_arm/)
  assert.match(dictionary.zh.emptyHttpBody, /x-overwatch-token/)
  assert.match(dictionary.zh.fishRestoreSafety, /confirmToken/)
  assert.match(dictionary.en.fishRestoreSafety, /confirmToken/)
  assert.match(dictionary.zh.fishRestoreSafetyGit, /git/)
  assert.match(dictionary.en.tabReplay, /Replay/)
  assert.match(dictionary.zh.tabFish, /鱼缸/)
})

test('uses the documented same-origin /overwatch/api and fishkeeper contract', () => {
  assert.match(SOURCE, /const API = '\/overwatch\/api'/)
  assert.ok(SOURCE.includes('apiGet(`/runs/${encodeURIComponent(selectedRunId)}`'))
  assert.ok(SOURCE.includes('/cases?state=${encodeURIComponent(caseFilter)}&limit=100'))
  assert.ok(SOURCE.includes('/cases/${encodeURIComponent(selectedCaseId)}`'))
  assert.ok(SOURCE.includes('/timeline?since=${encodeURIComponent(cursor)}&limit=${TIMELINE_PAGE_LIMIT}'))
  assert.ok(SOURCE.includes('/timeline?since=${encodeURIComponent(timelineCursorRef.current)}&limit=${TIMELINE_PAGE_LIMIT}'))
  assert.ok(SOURCE.includes("apiGet('/fish'"))
  assert.ok(SOURCE.includes("apiGetRaw('/doctor'"))
  assert.ok(SOURCE.includes("fishkeeperRequest('/overview'"))
  assert.ok(SOURCE.includes('/checkpoints?source=${encodeURIComponent(fishSourceId)}'))
  assert.ok(SOURCE.includes("fishkeeperRequest('/checkpoint/restore'"))
  assert.ok(SOURCE.includes('/restores`'))
  assert.ok(SOURCE.includes('/arm`'))
  assert.ok(SOURCE.includes('/disarm`'))
  assert.ok(SOURCE.includes('/ack`'))
  assert.ok(SOURCE.includes("'x-overwatch-token': token"))
  assert.ok(SOURCE.includes("method: 'POST'"))
})

test('keeps the write token in sessionStorage and never persists the fishkeeper confirmToken', () => {
  assert.ok(SOURCE.includes('sessionStorage'))
  assert.ok(SOURCE.includes('TOKEN_KEY'))
  assert.ok(SOURCE.includes("sessionStorage.setItem(TOKEN_KEY, value)"))
  assert.equal((SOURCE.match(/sessionStorage\.setItem\(/g) ?? []).length, 1, 'only the write token may be stored')
  assert.ok(SOURCE.includes("type: 'password'"))
  assert.ok(!SOURCE.includes('localStorage.'), 'token must not use localStorage')
  assert.ok(!SOURCE.includes('document.cookie'), 'token must not be written to cookies')
  assert.ok(!SOURCE.includes('console.'), 'the client must not log')
  assert.ok(!SOURCE.includes('dangerouslySetInnerHTML'))
  assert.ok(!SOURCE.includes('innerHTML'))
  // confirmToken must never reach storage, a URL, the DOM, or a log call.
  const confirmLines = SOURCE.split('\n').filter((line) => line.includes('confirmToken'))
  assert.ok(confirmLines.length >= 2, 'the restore flow must handle the fishkeeper confirmToken')
  for (const line of confirmLines) {
    assert.doesNotMatch(line, /sessionStorage|localStorage|console\.|encodeURIComponent|history\.|href|URLSearchParams/,
      `confirmToken must not be persisted or placed in a URL: ${line.trim()}`)
  }
  assert.ok(!SOURCE.includes('sessionStorage.setItem(TOKEN_KEY, confirmToken)'))
})

test('pauses polling while hidden and cleans up timers, listeners, and requests', () => {
  assert.ok(SOURCE.includes('document.hidden'))
  assert.ok(SOURCE.includes("addEventListener('visibilitychange'"))
  assert.ok(SOURCE.includes("removeEventListener('visibilitychange'"))
  assert.ok(SOURCE.includes('AbortController'))
  assert.ok(SOURCE.includes('controller.abort()'))
  assert.ok(SOURCE.includes('clearTimeout'))
  assert.ok(SOURCE.includes('setTimeout'))
  assert.ok(SOURCE.includes('writeAbortRef.current.abort()'))
  assert.ok(SOURCE.includes('timelineManualAbortRef.current.abort()'))
  assert.ok(SOURCE.includes('restoreAbortRef.current.abort()'))
})

test('renders through translated labels and does not invent unknown event times', () => {
  assert.ok(SOURCE.includes('formatTime'))
  assert.ok(SOURCE.includes("formatTime(event.at)"))
  assert.ok(SOURCE.includes("t('unknownTime')"))
  assert.ok(SOURCE.includes('Intl.DateTimeFormat'))
  assert.ok(SOURCE.includes('Intl.NumberFormat'))
  assert.ok(SOURCE.includes('Intl.RelativeTimeFormat'))
})

test('exposes both the guard-only and the supervised M2 surface', () => {
  assert.match(dictionary.zh.supervisedBanner, /supervised/)
  assert.match(dictionary.en.supervisedBanner, /supervised/)
  assert.ok(SOURCE.includes("value: 'supervised'"), 'arm mode select must offer supervised')
  assert.ok(SOURCE.includes("armSupervised"), 'supervised mode label must be translated')
  assert.ok(SOURCE.includes("watchStateLabel"), 'watch officer state must be rendered')
  assert.ok(!SOURCE.includes('/decide'), 'the panel must not expose the agent decision tool as an HTTP route')
  assert.ok(!SOURCE.includes('/purge'), 'the panel must not expose purge')
  assert.ok(!SOURCE.includes('/shift/latest'), 'the panel must not depend on the shift route')
})

test('wires M3 fish, replay, doctor, restore, opaque cursors, and tablist keyboard', () => {
  // Tabs and accessible tab semantics.
  assert.ok(SOURCE.includes("const TAB_ORDER = ['room', 'cases', 'fish', 'replay']"))
  assert.ok(SOURCE.includes("'aria-selected': tab === key"))
  assert.ok(SOURCE.includes("role: 'tablist'"))
  assert.ok(SOURCE.includes("role: 'tab'"))
  assert.ok(SOURCE.includes("role: 'tabpanel'"))
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    assert.ok(SOURCE.includes(`'${key}'`), `tablist keyboard must handle ${key}`)
  }
  // Opaque cursor: echo `nextSince` verbatim, never parse it or re-sort.
  assert.ok(SOURCE.includes("typeof data.nextSince === 'string' ? data.nextSince : String(data.nextSince ?? cursor)"))
  assert.ok(SOURCE.includes("typeof data.nextSince === 'string' ? data.nextSince : String(data.nextSince ?? timelineCursorRef.current)"))
  assert.ok(!SOURCE.includes('Number(data.nextSince)'), 'nextSince must stay opaque')
  assert.ok(!SOURCE.includes('timeline.sort'), 'the panel must not sort the server timeline')
  assert.ok(!SOURCE.includes('collected.sort'), 'the panel must not sort the server timeline')
  // Source chips for the merged timeline.
  assert.ok(SOURCE.includes('ow-source-chip'))
  assert.ok(SOURCE.includes('function sourceChip'))
  assert.ok(SOURCE.includes("['swarm', 'pressure', 'watch']"))
  // Fish and replay poll at their documented intervals.
  assert.match(SOURCE, /FISH_POLL_MS = 15000/)
  assert.match(SOURCE, /TIMELINE_POLL_MS = 5000/)
  assert.match(SOURCE, /DOCTOR_POLL_MS = 15000/)
  // Restore evidence: intent before execution and result after it.
  assert.ok(SOURCE.includes("postRestoreRecord('intent'"))
  assert.ok(SOURCE.includes("postRestoreRecord('result'"))
  assert.ok(SOURCE.includes('phase,'))
  assert.ok(SOURCE.includes("phase === 'result'"))
  assert.ok(SOURCE.includes('body.result = {'))
  assert.match(SOURCE, /phase,\n\s+files:/)
  // Fish degradation and doctor handling.
  assert.ok(SOURCE.includes("error?.status === 401"))
  assert.ok(SOURCE.includes('function browserFailureKind'))
  assert.ok(SOURCE.includes("apiGetRaw('/doctor'"))
  assert.ok(SOURCE.includes('doctorStatusLabel'))
  assert.ok(SOURCE.includes('summarizeDetail'))
  // Restore dialog accessibility.
  assert.ok(SOURCE.includes("'aria-modal': 'true'"))
  assert.ok(SOURCE.includes('ow-steps'))
  assert.ok(SOURCE.includes("event.key === 'Escape'"))
  assert.ok(SOURCE.includes("event.key !== 'Tab'"))
  assert.ok(SOURCE.includes('previous.focus()'))
  assert.ok(SOURCE.includes('restoreDialogRef'))
  assert.ok(SOURCE.includes('restoreTokenRef'))
})

// ---------------------------------------------------------------------------
// Render fixtures and harness
// ---------------------------------------------------------------------------

function makeFixture(options = {}) {
  const now = Date.now()
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  const freshness = {
    swarm: { ok: true, at: at(0), ageMs: 1200, error: null },
    pressure: { ok: true, at: at(0), ageMs: 2400, error: null },
    fish: { ok: false, at: null, ageMs: null, error: 'HTTP 401' },
  }
  const runSummary = {
    runId: 'run_1',
    armed: true,
    state: 'watching',
    mode: 'guard',
    goal: 'Ship the M1 panel',
    status: 'running',
    budget: { limit: 100000, spent: 84000, ratio: 0.84 },
    openCases: 2,
    updatedAt: at(0),
  }
  const runDetail = {
    runId: 'run_1',
    armed: true,
    state: 'watching',
    mode: 'guard',
    goal: 'Ship the M1 panel',
    status: 'running',
    snapshot: {
      status: 'running',
      round: 2,
      goal: 'Ship the M1 panel',
      budget: { limit: 100000, spent: 84000, ratio: 0.84, reserve: 5000 },
      members: [{ id: 'm1', name: 'worker-1', role: 'worker', status: 'working', context: 0.6 }],
      tasks: { queued: 2, working: 1, reviewing: 1, approved: 3, blocked: 0, merged: 4 },
      reviews: { open: 1, oldestMs: 120000 },
      merge: { queue: 1, conflicts: 0 },
      lastEventAt: at(10),
    },
    freshness,
    budget: { limit: 100000, spent: 84000, ratio: 0.84, reserve: 5000 },
    cases: { open: 2, bySeverity: { L1: 0, L2: 1, L3: 1, L4: 0 } },
    lastEventAt: at(10),
    armedAt: at(30),
    disarmedAt: null,
  }
  const caseSummary = {
    id: 'case_1',
    state: 'open',
    severity: 'L3',
    title: 'Budget cliff',
    code: 'budget_cliff',
    openedAt: at(20),
    updatedAt: at(10),
    closedAt: null,
    closeReason: null,
    signals: [{ code: 'budget_pressure', severity: 'L3', value: 0.86, threshold: 0.8 }],
    actions: [],
  }
  const caseDetail = {
    case: {
      ...caseSummary,
      evidence: [{ kind: 'receipt', id: 'turn_7', source: 'pressure', at: at(20) }],
      decisions: [{ verdict: 'requires_human', actor: 'guard', at: at(10) }],
      actions: [
        { id: 'act_1', kind: 'pause', state: 'intended', at: at(9) },
        { id: 'act_1', kind: 'pause', state: 'executed', at: at(8) },
        { id: 'act_1', kind: 'pause', state: 'verified', at: at(7) },
      ],
    },
    timeline: [],
    asOf: at(0),
  }
  const timeline = options.timelineCount === undefined
    ? [
        { seq: 1, source: 'watch', type: 'watch/armed', at: at(30), actor: 'human', summary: 'watch/armed run_1' },
        { seq: 1, source: 'swarm', type: 'dispatch/started', at: at(25), actor: 'swarm', summary: 'dispatch started' },
        { seq: 2, source: 'watch', type: 'case/opened', at: at(20), actor: 'guard', summary: 'case/opened case_1' },
        { seq: 3, source: 'watch', type: 'action/verified', at: at(7), actor: 'guard', summary: 'action/verified act_1' },
      ]
    : Array.from({ length: options.timelineCount }, (_, index) => ({
        seq: index + 1,
        source: index % 3 === 0 ? 'watch' : index % 3 === 1 ? 'swarm' : 'pressure',
        type: `flow/event-${index}`,
        at: index === 3 ? null : new Date(now - (options.timelineCount - index) * 60_000).toISOString(),
        actor: 'system',
        summary: `event ${index}`,
      }))
  const fishIndex = {
    available: true,
    dataDir: 'C:/Users/fish/.dsh/fishkeeper',
    sources: [{
      sourceId: 'fish_1',
      checkpoints: [
        { id: 'ck_1', createdAt: at(60), trigger: 'baseline', files: 3, storedBytes: 4096, pinned: true, baseline: true },
        { id: 'ck_2', createdAt: at(30), trigger: 'pre-restore', files: 2, storedBytes: 1024, pinned: false, baseline: false },
      ],
      audit: [
        { at: at(20), action: 'restore', checkpointId: 'ck_2', result: 'ok', error: null },
        { at: at(40), action: 'pin', checkpointId: 'ck_1', result: null, error: null },
      ],
    }],
    errors: [],
  }
  const fishOverview = {
    generatedAt: at(0),
    mode: 'writer',
    sources: [{
      id: 'fish_1',
      displayName: 'Diary fish',
      adapter: 'file',
      readOnly: false,
      status: 'ok',
      capabilities: { restore: true },
    }],
  }
  const fishCheckpoints = {
    sourceId: 'fish_1',
    readOnly: false,
    restoreSupported: true,
    items: [
      { id: 'ck_1', createdAt: at(60), trigger: 'baseline', files: 3, storedBytes: 4096, logicalBytes: 8192, pinned: true, baseline: true },
      { id: 'ck_2', createdAt: at(30), trigger: 'pre-restore', files: 2, storedBytes: 1024, logicalBytes: 2048, pinned: false, baseline: false },
    ],
  }
  const restorePlan = {
    checkpointId: 'ck_2',
    sourceId: 'fish_1',
    sourceName: 'Diary fish',
    warnings: ['notes/diary.md changed after the checkpoint.'],
    files: [
      { path: 'notes/diary.md', role: 'diary', action: 'restore', stale: true, bytes: 2048 },
      { path: 'profile/persona.md', role: 'persona', action: 'restore', stale: false, bytes: 512 },
      { path: 'events.jsonl', role: 'events', action: 'skip', reason: 'not-restorable' },
    ],
    confirmToken: 'confirm-secret-token',
  }
  const restoreResult = {
    ok: true,
    checkpointId: 'ck_2',
    safetyCheckpointId: 'ck_pre_2',
    restored: 2,
    files: [
      { path: 'notes/diary.md', ok: true, sha256: 'sha-diary' },
      { path: 'profile/persona.md', ok: true, sha256: 'sha-persona' },
    ],
  }
  const doctor = [
    { id: 'data-dir', status: 'pass', detail: { path: 'C:/tmp/overwatch', writable: true } },
    { id: 'fish-index', status: 'warn', detail: { available: true, sources: 1 } },
  ]
  return {
    now,
    at,
    freshness,
    runSummary,
    runDetail,
    caseSummary,
    caseDetail,
    timeline,
    fishIndex,
    fishOverview,
    fishCheckpoints,
    restorePlan,
    restoreResult,
    doctor,
  }
}

function installSandbox(target, fixture, calls, options = {}) {
  const empty = options.empty === true
  const fishkeeperMode = options.fishkeeper ?? 'ok'
  const doctorMode = options.doctor ?? 'ok'
  const restoreExecuteFails = options.restoreExecuteFails === true
  const storage = new Map()
  let timerId = 0
  const document = {
    hidden: false,
    documentElement: { lang: 'zh-CN' },
    activeElement: { focus() {}, isConnected: true },
    addEventListener() {},
    removeEventListener() {},
    getElementById() {
      return null
    },
  }
  const ok = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })
  const fail = (payload, status) => ({
    ok: false,
    status,
    json: async () => payload,
  })
  const fishkeeperFailure = () => {
    if (fishkeeperMode === 'network') throw new TypeError('Failed to fetch')
    if (fishkeeperMode === 'unauthorized') {
      return fail({ error: { code: 'fishkeeper/source-unauthorized', message: 'browser credentials required' } }, 401)
    }
    if (fishkeeperMode === 'not-found') return fail({ error: { code: 'fishkeeper/not-found', message: 'route not found' } }, 404)
    return null
  }
  target.AbortController = AbortController
  target.document = document
  target.window.document = document
  target.navigator = { language: 'zh-CN' }
  target.sessionStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  }
  target.setTimeout = () => {
    timerId += 1
    return timerId
  }
  target.clearTimeout = () => {}
  target.fetch = async (input, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase()
    const url = String(input)
    const parsed = new URL(url, 'http://127.0.0.1:56819')
    const path = parsed.pathname
    let body
    try {
      body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined
    } catch {
      body = undefined
    }
    calls.push({ method, url, path, headers: options.headers ?? {}, body })
    if (method === 'POST') {
      if (path === '/api/fishkeeper/checkpoint/restore') {
        const failure = fishkeeperFailure()
        if (failure !== null) return failure
        if (body?.dryRun === false) {
          if (restoreExecuteFails) {
            return fail({ error: { code: 'fishkeeper/restore-stale', message: 'Files changed after the checkpoint.' } }, 409)
          }
          return ok(fixture.restoreResult)
        }
        return ok(fixture.restorePlan)
      }
      if (path.endsWith('/arm')) {
        fixture.runSummary.armed = true
        fixture.runSummary.state = 'watching'
        fixture.runDetail.armed = true
        fixture.runDetail.state = 'watching'
        return ok({ ok: true, data: { runId: 'run_1', mode: 'guard', state: 'watching', armed: true, reserve: 5000 } })
      }
      if (path.endsWith('/disarm')) {
        fixture.runSummary.armed = false
        fixture.runSummary.state = 'disarmed'
        fixture.runDetail.armed = false
        fixture.runDetail.state = 'disarmed'
        return ok({ ok: true, data: { runId: 'run_1', state: 'disarmed' } })
      }
      if (path.endsWith('/ack')) {
        fixture.caseSummary.state = 'acknowledged'
        fixture.caseDetail.case.state = 'acknowledged'
        return ok({ ok: true, data: { case: { ...fixture.caseSummary, state: 'acknowledged' } } })
      }
      if (path === '/overwatch/api/runs/run_1/restores') {
        return ok({
          ok: true,
          data: {
            recorded: true,
            phase: body?.phase,
            sourceId: body?.sourceId,
            checkpointId: body?.checkpointId,
          },
        })
      }
      return ok({ ok: false, code: 'NOT_FOUND', message: 'unknown write route' }, 404)
    }
    if (path === '/api/fishkeeper/overview') {
      const failure = fishkeeperFailure()
      if (failure !== null) return failure
      return ok(fixture.fishOverview)
    }
    if (path === '/api/fishkeeper/checkpoints') {
      const failure = fishkeeperFailure()
      if (failure !== null) return failure
      return ok({ ...fixture.fishCheckpoints, sourceId: parsed.searchParams.get('source') ?? fixture.fishCheckpoints.sourceId })
    }
    if (path === '/overwatch/api/fish') {
      return ok({ ok: true, data: fixture.fishIndex, asOf: new Date().toISOString() })
    }
    if (path === '/overwatch/api/doctor') {
      if (doctorMode === 'error') return fail({ ok: false, code: 'INTERNAL', message: 'doctor failed' }, 500)
      return ok({
        ok: doctorMode === 'warn' ? false : true,
        version: '0.1.0',
        dataDir: 'C:/tmp/overwatch',
        checks: fixture.doctor,
        asOf: new Date().toISOString(),
      })
    }
    if (path === '/overwatch/api/health') {
      return ok({
        ok: true,
        version: '0.1.0',
        mode: 'guard',
        dataDir: 'C:/tmp/overwatch',
        service: { watch: { ok: true, events: 42, error: null } },
        runs: empty ? [] : [{
          runId: 'run_1',
          state: 'watching',
          armed: true,
          freshness: fixture.freshness,
          log: { ok: true, count: 12, lastHash: 'abc' },
        }],
        asOf: new Date().toISOString(),
      })
    }
    if (path === '/overwatch/api/runs') {
      return ok({ ok: true, data: { runs: empty ? [] : [fixture.runSummary], asOf: new Date().toISOString() } })
    }
    if (path === '/overwatch/api/runs/run_1/timeline') {
      const rawSince = parsed.searchParams.get('since') ?? '0'
      const limit = Number(parsed.searchParams.get('limit') ?? '100')
      const start = rawSince === '' || rawSince === '0'
        ? 0
        : (rawSince.startsWith('c:') && Number.isFinite(Number(rawSince.slice(2))) ? Number(rawSince.slice(2)) : 0)
      const events = fixture.timeline.slice(start, start + limit)
      const nextSince = events.length > 0 ? `c:${start + events.length}` : (rawSince === '' ? '0' : rawSince)
      return ok({
        ok: true,
        data: {
          events,
          nextSince,
          total: fixture.timeline.length,
          asOf: new Date().toISOString(),
        },
      })
    }
    if (path === '/overwatch/api/runs/run_1/cases') {
      const state = parsed.searchParams.get('state') ?? 'all'
      const cases = state === 'open'
        ? [fixture.caseSummary].filter((entry) => entry.state !== 'closed')
        : [fixture.caseSummary]
      return ok({ ok: true, data: { cases, asOf: new Date().toISOString() } })
    }
    if (path === '/overwatch/api/runs/run_1/cases/case_1') {
      return ok({ ok: true, data: fixture.caseDetail })
    }
    if (path === '/overwatch/api/runs/run_1') {
      return ok({ ok: true, data: { ...fixture.runDetail, asOf: new Date().toISOString() } })
    }
    return ok({ ok: false, code: 'NOT_FOUND', message: 'unknown route' }, 404)
  }
  return { storage }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.kind === 'text') return node.value
  if (node.kind === 'fragment') return node.children.map(textOf).join(' ')
  if (node.kind === 'element') return node.children.map(textOf).join(' ')
  return ''
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (node.kind === 'fragment') {
    for (const child of node.children) findAll(child, predicate, found)
    return found
  }
  if (node.kind === 'element') {
    if (predicate(node)) found.push(node)
    for (const child of node.children) findAll(child, predicate, found)
  }
  return found
}

function findOne(node, predicate) {
  return findAll(node, predicate)[0] ?? null
}

function createRenderHarness(moduleDefinition, target) {
  let hookSlots = []
  let hookIndex = 0
  let pendingEffects = []
  let dirty = true
  let tree = null
  let unmounted = false

  const react = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== undefined)
      return { type, props: { ...(props ?? {}), children: flat }, children: flat }
    },
    useState(initial) {
      const index = hookIndex
      hookIndex += 1
      if (hookSlots[index] === undefined) {
        hookSlots[index] = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
          setter: null,
        }
      }
      const slot = hookSlots[index]
      if (slot.setter === null) {
        slot.setter = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            dirty = true
          }
        }
      }
      return [slot.value, slot.setter]
    },
    useRef(initial) {
      const index = hookIndex
      hookIndex += 1
      if (hookSlots[index] === undefined) hookSlots[index] = { kind: 'ref', ref: { current: initial } }
      return hookSlots[index].ref
    },
    useEffect(fn, deps) {
      const index = hookIndex
      hookIndex += 1
      if (hookSlots[index] === undefined) {
        hookSlots[index] = { kind: 'effect', deps: undefined, cleanup: null }
      }
      const slot = hookSlots[index]
      const changed = deps === undefined
        || slot.deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((value, offset) => !Object.is(value, slot.deps[offset]))
      if (changed) {
        slot.deps = deps === undefined ? undefined : [...deps]
        pendingEffects.push({ index, fn })
      }
    },
  }

  const dictionaries = []
  const slots = []
  let dictionary = null
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict })
        dictionary = dict
        return () => {}
      },
      bind(namespace) {
        assert.equal(namespace, 'dshOverwatch')
        return (key, params) => {
          let text = dictionary?.zh?.[key] ?? key
          if (params !== undefined && params !== null && typeof text === 'string') {
            for (const [name, value] of Object.entries(params)) {
              text = text.split(`{${name}}`).join(String(value))
            }
          }
          return text
        }
      },
      subscribe() {
        return () => {}
      },
      getLocale() {
        return { active: 'zh' }
      },
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  const plugin = moduleDefinition.factory((id) => {
    assert.equal(id, 'react')
    return react
  })
  plugin.apply(ctx)
  const main = slots.find((entry) => entry.options.name === 'main')
  assert.notEqual(main, undefined)
  const Root = main.component

  function renderNode(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', value: String(node) }
    if (Array.isArray(node)) return { kind: 'fragment', children: node.map(renderNode).filter(Boolean) }
    if (typeof node === 'function') return renderNode(node({}))
    if (typeof node === 'object' && node.type !== undefined) {
      if (typeof node.type === 'function') return renderNode(node.type(node.props))
      if (typeof node.type === 'string') {
        return { kind: 'element', type: node.type, props: node.props, children: node.children.map(renderNode).filter(Boolean) }
      }
    }
    return null
  }

  function flushEffects() {
    const run = pendingEffects
    pendingEffects = []
    for (const { index, fn } of run) {
      const slot = hookSlots[index]
      if (typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup
        slot.cleanup = null
        cleanup()
      }
      const cleanup = fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  function renderOnce() {
    if (unmounted) return tree
    hookIndex = 0
    pendingEffects = []
    tree = renderNode(Root({}))
    flushEffects()
    return tree
  }

  async function flush(rounds = 40) {
    for (let round = 0; round < rounds; round += 1) {
      if (dirty) {
        dirty = false
        renderOnce()
      }
      await new Promise((resolve) => setImmediate(resolve))
      await Promise.resolve()
    }
    return tree
  }

  function unmount() {
    unmounted = true
    for (const slot of hookSlots) {
      if (slot !== undefined && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup()
        } catch {
          // ignore cleanup failures during the smoke test
        }
      }
    }
    hookSlots = []
  }

  return { flush, unmount, getTree: () => tree, dictionaries, slots }
}

function tabButton(tree, label) {
  return findOne(tree, (element) => element.type === 'button'
    && element.props.role === 'tab'
    && textOf(element).includes(label))
}

// ---------------------------------------------------------------------------
// Render smoke tests
// ---------------------------------------------------------------------------

test('render smoke: watch room, freshness, cases, detail drawer, and gated writes', async () => {
  const fixture = makeFixture()
  const calls = []
  const env = installSandbox(sandbox, fixture, calls)
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  let text = textOf(tree)
  assert.match(text, /guard-only/)
  assert.match(text, /run_1/)
  assert.match(text, /Ship the M1 panel/)
  assert.match(text, /84/)
  assert.match(text, /正常/)
  assert.match(text, /不可用/)
  assert.match(text, /未决事件单/)
  assert.match(text, /最近 watch 事件/)
  assert.match(text, /case\/opened/)
  assert.match(text, /校验通过/)
  assert.match(text, /运行锁/)
  assert.match(text, /自检（doctor）/)
  assert.match(text, /fish-index/)
  assert.match(text, /警告/)
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/health'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/runs'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/doctor'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.includes('/runs/run_1/timeline?since=0')))

  const casesTab = tabButton(tree, '事件单')
  assert.notEqual(casesTab, null)
  casesTab.props.onClick({})
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /Budget cliff/)
  assert.match(text, /budget_cliff/)

  const caseRow = findOne(tree, (element) => element.type === 'tr' && element.props.tabIndex === 0 && typeof element.props.onClick === 'function')
  assert.notEqual(caseRow, null)
  caseRow.props.onClick({})
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /budget_pressure/)
  assert.match(text, /turn_7/)
  assert.match(text, /证据引用/)
  assert.match(text, /动作时间线/)
  assert.match(text, /写操作已隐藏/)
  assert.equal(findOne(tree, (element) => element.type === 'input' && element.props.type === 'password'), null)
  assert.equal(findOne(tree, (element) => element.type === 'button' && textOf(element).includes('确认接管')), null)

  const writeToggle = findOne(tree, (element) => element.type === 'button' && textOf(element).includes('展开写操作'))
  assert.notEqual(writeToggle, null)
  writeToggle.props.onClick({})
  tree = await harness.flush()
  const passwordInput = findOne(tree, (element) => element.type === 'input' && element.props.type === 'password')
  assert.notEqual(passwordInput, null)
  assert.equal(findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '解散'), null)
  passwordInput.props.onChange({ target: { value: 'secret-token' } })
  tree = await harness.flush()
  const tokenForm = findOne(tree, (element) => element.type === 'form' && element.props.className === 'ow-token-form')
  assert.notEqual(tokenForm, null)
  tokenForm.props.onSubmit({ preventDefault() {} })
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /写操作已解锁/)
  assert.match(text, /Token 已设置/)
  assert.equal(env.storage.get(TOKEN_KEY), 'secret-token')
  assert.ok(!text.includes('secret-token'), 'the token must never be rendered in plain text')
  const passwordAfterSave = findOne(tree, (element) => element.type === 'input' && element.props.type === 'password')
  assert.equal(passwordAfterSave.props.value, '')
  assert.notEqual(findOne(tree, (element) => element.type === 'button' && textOf(element).includes('确认接管')), null)

  const disarmButton = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '解散')
  assert.notEqual(disarmButton, null)
  disarmButton.props.onClick({})
  tree = await harness.flush()
  const confirmButton = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '确认' && String(element.props.className).includes('ow-btn-primary'))
  assert.notEqual(confirmButton, null)
  confirmButton.props.onClick({})
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /运行已解散/)
  assert.ok(calls.some((call) => call.method === 'POST'
    && call.url.includes('/overwatch/api/runs/run_1/disarm')
    && call.headers['x-overwatch-token'] === 'secret-token'))

  harness.unmount()
})

test('render smoke: empty state explains the agent tool and HTTP entry points', async () => {
  const fixture = makeFixture()
  const calls = []
  installSandbox(sandbox, fixture, calls, { empty: true })
  const harness = createRenderHarness(definition, sandbox)
  const tree = await harness.flush()
  const text = textOf(tree)
  assert.match(text, /还没有受监管的运行/)
  assert.match(text, /watch_arm/)
  assert.match(text, /POST \/overwatch\/api\/runs\/:id\/arm/)
  assert.match(text, /x-overwatch-token/)
  assert.ok(calls.some((call) => call.url === '/overwatch/api/runs'))
  harness.unmount()
})

test('render smoke: fish host index and the fishkeeper browser surface', async () => {
  const fixture = makeFixture()
  const calls = []
  installSandbox(sandbox, fixture, calls)
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  const fishTab = tabButton(tree, '鱼缸')
  assert.notEqual(fishTab, null)
  fishTab.props.onClick({})
  tree = await harness.flush()
  const text = textOf(tree)
  assert.match(text, /鱼缸/)
  assert.match(text, /宿主索引/)
  assert.match(text, /fishkeeper 数据目录/)
  assert.match(text, /fish_1/)
  assert.match(text, /ck_1/)
  assert.match(text, /已固定/)
  assert.match(text, /基线/)
  assert.match(text, /恢复前/)
  assert.match(text, /最近审计/)
  assert.match(text, /浏览器面可用/)
  assert.match(text, /Diary fish/)
  assert.match(text, /支持恢复/)
  const restoreButton = findOne(tree, (element) => element.type === 'button' && element.props['aria-label'] === '恢复 ck_1')
  assert.notEqual(restoreButton, null)
  assert.equal(restoreButton.props.disabled, true, 'restore is gated until a write token is set')
  assert.match(text, /先设置 overwatch 写 token/)
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/fish'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/api/fishkeeper/overview'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.includes('/api/fishkeeper/checkpoints?source=fish_1')))
  harness.unmount()
})

test('render smoke: fish degrades to the host index when fishkeeper returns 401', async () => {
  const fixture = makeFixture()
  const calls = []
  installSandbox(sandbox, fixture, calls, { fishkeeper: 'unauthorized' })
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  const fishTab = tabButton(tree, '鱼缸')
  assert.notEqual(fishTab, null)
  fishTab.props.onClick({})
  tree = await harness.flush()
  const text = textOf(tree)
  assert.match(text, /仅宿主索引可用/)
  assert.match(text, /401/)
  assert.match(text, /浏览器凭据/)
  assert.match(text, /ck_1/)
  assert.match(text, /已固定/)
  assert.match(text, /基线/)
  const restoreButton = findOne(tree, (element) => element.type === 'button' && element.props['aria-label'] === '恢复 ck_1')
  assert.notEqual(restoreButton, null)
  assert.equal(restoreButton.props.disabled, true)
  harness.unmount()
})

test('render smoke: replay paginates with nextSince and marks unknown times', async () => {
  const fixture = makeFixture({ timelineCount: 820 })
  const calls = []
  installSandbox(sandbox, fixture, calls)
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  const replayTab = tabButton(tree, '回放')
  assert.notEqual(replayTab, null)
  replayTab.props.onClick({})
  tree = await harness.flush()
  let text = textOf(tree)
  assert.match(text, /回放/)
  assert.match(text, /蜂群/)
  assert.match(text, /压力表/)
  assert.match(text, /值班员/)
  assert.match(text, /时间未知/)
  assert.match(text, /flow\/event-799/)
  assert.ok(!text.includes('flow/event-800'))
  assert.match(text, /已加载 800 \/ 820/)
  const loadMore = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '加载更多')
  assert.notEqual(loadMore, null)
  const lastPageRequest = calls.filter((call) => call.path === '/overwatch/api/runs/run_1/timeline').at(-1)
  assert.equal(new URL(lastPageRequest.url, 'http://127.0.0.1').searchParams.get('since'), 'c:700')
  loadMore.props.onClick({})
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /flow\/event-800/)
  assert.match(text, /flow\/event-819/)
  assert.match(text, /已加载 820 \/ 820/)
  assert.match(text, /已全部加载/)
  const requests = calls.filter((call) => call.path === '/overwatch/api/runs/run_1/timeline')
  assert.ok(requests.some((call) => new URL(call.url, 'http://127.0.0.1').searchParams.get('since') === 'c:800'),
    'load more must echo the opaque nextSince cursor')
  harness.unmount()
})

test('render smoke: doctor warns and a failing doctor can be retried', async () => {
  const fixture = makeFixture()
  const calls = []
  installSandbox(sandbox, fixture, calls)
  const harness = createRenderHarness(definition, sandbox)
  let tree = await harness.flush()
  let text = textOf(tree)
  assert.match(text, /自检（doctor）/)
  assert.match(text, /fish-index/)
  assert.match(text, /警告/)
  assert.match(text, /通过/)
  harness.unmount()

  const failedCalls = []
  installSandbox(sandbox, fixture, failedCalls, { doctor: 'error' })
  const failedHarness = createRenderHarness(definition, sandbox)
  tree = await failedHarness.flush()
  text = textOf(tree)
  assert.match(text, /自检请求失败/)
  const retryButton = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '重试')
  assert.notEqual(retryButton, null)
  retryButton.props.onClick({})
  await failedHarness.flush()
  assert.ok(failedCalls.filter((call) => call.path === '/overwatch/api/doctor').length >= 2)
  failedHarness.unmount()
})

test('render smoke: restore preflight, confirm, execute, and per-file result', async () => {
  const fixture = makeFixture()
  const calls = []
  const env = installSandbox(sandbox, fixture, calls)
  env.storage.set(TOKEN_KEY, 'secret-token')
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  const fishTab = tabButton(tree, '鱼缸')
  assert.notEqual(fishTab, null)
  fishTab.props.onClick({})
  tree = await harness.flush()

  const restoreButton = findOne(tree, (element) => element.type === 'button' && element.props['aria-label'] === '恢复 ck_1')
  assert.notEqual(restoreButton, null)
  assert.equal(restoreButton.props.disabled, false)
  restoreButton.props.onClick({})
  tree = await harness.flush()
  let text = textOf(tree)
  assert.match(text, /恢复检查点/)
  assert.match(text, /影响预览/)
  assert.match(text, /notes\/diary\.md/)
  assert.match(text, /events\.jsonl/)
  assert.match(text, /Diary fish/)
  assert.match(text, /changed after the checkpoint/)
  assert.match(text, /覆盖较新内容/)
  assert.match(text, /pre-restore 安全检查点/)
  assert.match(text, /代码回滚不在此流程/)
  assert.ok(!text.includes('confirm-secret-token'), 'the confirmToken must never be rendered')

  const intentCalls = calls.filter((call) => call.path === '/overwatch/api/runs/run_1/restores' && call.body?.phase === 'intent')
  assert.equal(intentCalls.length, 1)
  assert.equal(intentCalls[0].headers['x-overwatch-token'], 'secret-token')
  assert.deepEqual(intentCalls[0].body.files, ['notes/diary.md', 'profile/persona.md'])
  assert.equal(intentCalls[0].body.checkpointId, 'ck_2')
  assert.equal(intentCalls[0].body.sourceId, 'fish_1')
  assert.ok(Array.isArray(intentCalls[0].body.warnings))
  assert.ok(!JSON.stringify(intentCalls[0].body).includes('confirmToken'))

  const executeBefore = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '执行恢复')
  assert.notEqual(executeBefore, null)
  assert.equal(executeBefore.props.disabled, true, 'stale files require the override before execution')

  const override = findOne(tree, (element) => element.type === 'input' && element.props.type === 'checkbox')
  assert.notEqual(override, null)
  assert.equal(override.props.checked, false)
  override.props.onChange({ target: { checked: true } })
  tree = await harness.flush()
  const executeAfter = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '执行恢复')
  assert.notEqual(executeAfter, null)
  assert.equal(executeAfter.props.disabled, false)
  executeAfter.props.onClick({})
  tree = await harness.flush()
  text = textOf(tree)
  assert.match(text, /恢复成功/)
  assert.match(text, /已恢复 2 个文件/)
  assert.match(text, /逐文件结果/)
  assert.match(text, /ck_pre_2/)
  assert.match(text, /结果已写入 overwatch 日志/)
  assert.ok(!text.includes('confirm-secret-token'), 'the confirmToken must never be rendered')

  const executeCalls = calls.filter((call) => call.method === 'POST'
    && call.path === '/api/fishkeeper/checkpoint/restore'
    && call.body?.dryRun === false)
  assert.equal(executeCalls.length, 1)
  assert.equal(executeCalls[0].body.confirmToken, 'confirm-secret-token')
  assert.equal(executeCalls[0].body.overrideStale, true)
  assert.deepEqual(executeCalls[0].body.files, ['notes/diary.md', 'profile/persona.md'])
  assert.ok(!executeCalls[0].url.includes('confirm-secret-token'))

  const resultCalls = calls.filter((call) => call.path === '/overwatch/api/runs/run_1/restores' && call.body?.phase === 'result')
  assert.equal(resultCalls.length, 1)
  assert.equal(resultCalls[0].body.result.ok, true)
  assert.equal(resultCalls[0].body.result.files.length, 2)
  assert.ok(!JSON.stringify(resultCalls[0].body).includes('confirmToken'))
  assert.ok(!JSON.stringify(Array.from(env.storage.entries())).includes('confirm-secret-token'))
  assert.equal(env.storage.get(TOKEN_KEY), 'secret-token')

  const closeButton = findOne(tree, (element) => element.type === 'button' && element.props['aria-label'] === '关闭')
  assert.notEqual(closeButton, null)
  closeButton.props.onClick({})
  tree = await harness.flush()
  assert.ok(!textOf(tree).includes('影响预览'))
  harness.unmount()
})

test('render smoke: a failed restore records a failed result and forces a new preflight', async () => {
  const fixture = makeFixture()
  const calls = []
  const env = installSandbox(sandbox, fixture, calls, { restoreExecuteFails: true })
  env.storage.set(TOKEN_KEY, 'secret-token')
  const harness = createRenderHarness(definition, sandbox)

  let tree = await harness.flush()
  const fishTab = tabButton(tree, '鱼缸')
  assert.notEqual(fishTab, null)
  fishTab.props.onClick({})
  tree = await harness.flush()

  const restoreButton = findOne(tree, (element) => element.type === 'button' && element.props['aria-label'] === '恢复 ck_1')
  assert.notEqual(restoreButton, null)
  restoreButton.props.onClick({})
  tree = await harness.flush()

  const override = findOne(tree, (element) => element.type === 'input' && element.props.type === 'checkbox')
  assert.notEqual(override, null)
  override.props.onChange({ target: { checked: true } })
  tree = await harness.flush()

  const execute = findOne(tree, (element) => element.type === 'button' && textOf(element).trim() === '执行恢复')
  assert.notEqual(execute, null)
  execute.props.onClick({})
  tree = await harness.flush()
  const text = textOf(tree)
  assert.match(text, /恢复失败/)
  assert.match(text, /目标已变化/)
  assert.match(text, /重试/)
  assert.ok(!text.includes('confirm-secret-token'))

  const resultCalls = calls.filter((call) => call.path === '/overwatch/api/runs/run_1/restores' && call.body?.phase === 'result')
  assert.equal(resultCalls.length, 1)
  assert.equal(resultCalls[0].body.result.ok, false)
  assert.match(resultCalls[0].body.result.error, /Files changed/)
  assert.ok(!JSON.stringify(resultCalls[0].body).includes('confirmToken'))
  harness.unmount()
})
