import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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

test('covers panel, table, button, empty, error, and write-state copy', () => {
  const required = [
    'navLabel',
    'pageTitle',
    'guardOnlyBanner',
    'guardOnlyHint',
    'tabRoom',
    'tabCases',
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
  ]
  for (const key of required) assert.ok(keysOf('zh').has(key), `missing i18n key ${key}`)
  assert.match(dictionary.zh.guardOnlyBanner, /guard-only/)
  assert.match(dictionary.zh.supervisedHint, /M2/)
  assert.match(dictionary.en.guardOnlyBanner, /guard-only/)
  assert.match(dictionary.en.supervisedHint, /M2/)
  assert.match(dictionary.zh.emptyToolBody, /watch_arm/)
  assert.match(dictionary.zh.emptyHttpBody, /x-overwatch-token/)
})

test('uses the documented same-origin /overwatch/api contract', () => {
  assert.match(SOURCE, /const API = '\/overwatch\/api'/)
  assert.ok(SOURCE.includes('apiGet(`/runs/${encodeURIComponent(selectedRunId)}`'))
  assert.ok(SOURCE.includes('/cases?state=${encodeURIComponent(caseFilter)}&limit=100'))
  assert.ok(SOURCE.includes('/cases/${encodeURIComponent(selectedCaseId)}`'))
  assert.ok(SOURCE.includes('/timeline?since=${encodeURIComponent(String(since))}&limit=${TIMELINE_PAGE_LIMIT}'))
  assert.ok(SOURCE.includes('/arm`'))
  assert.ok(SOURCE.includes('/disarm`'))
  assert.ok(SOURCE.includes('/ack`'))
  assert.ok(SOURCE.includes("'x-overwatch-token': token"))
  assert.ok(SOURCE.includes("method: 'POST'"))
})

test('keeps the write token in sessionStorage and never prints or persists it elsewhere', () => {
  assert.ok(SOURCE.includes('sessionStorage'))
  assert.ok(SOURCE.includes('TOKEN_KEY'))
  assert.ok(SOURCE.includes('type: \'password\''))
  assert.ok(!SOURCE.includes('localStorage'), 'token must not use localStorage')
  assert.ok(!SOURCE.includes("document.cookie"), 'token must not be written to cookies')
  assert.ok(!SOURCE.includes('console.'), 'the client must not log')
  assert.ok(!SOURCE.includes('dangerouslySetInnerHTML'))
  assert.ok(!SOURCE.includes('innerHTML'))
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

function makeFixture() {
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
  const timeline = [
    { seq: 1, source: 'watch', type: 'watch/armed', at: at(30), actor: 'human', summary: 'watch/armed run_1' },
    { seq: 1, source: 'swarm', type: 'dispatch/started', at: at(25), actor: 'swarm', summary: 'dispatch started' },
    { seq: 2, source: 'watch', type: 'case/opened', at: at(20), actor: 'guard', summary: 'case/opened case_1' },
    { seq: 3, source: 'watch', type: 'action/verified', at: at(7), actor: 'guard', summary: 'action/verified act_1' },
  ]
  return { now, at, freshness, runSummary, runDetail, caseSummary, caseDetail, timeline }
}

function installSandbox(target, fixture, calls, options = {}) {
  const empty = options.empty === true
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
    calls.push({ method, url, headers: options.headers ?? {} })
    if (method === 'POST') {
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
      return ok({ ok: false, code: 'NOT_FOUND', message: 'unknown write route' }, 404)
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
      const since = Number(parsed.searchParams.get('since') ?? '0')
      const limit = Number(parsed.searchParams.get('limit') ?? '200')
      const events = fixture.timeline.slice(since, since + limit)
      return ok({ ok: true, data: { events, nextSince: since + events.length, total: fixture.timeline.length, asOf: new Date().toISOString() } })
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

  async function flush(rounds = 25) {
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
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/health'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/overwatch/api/runs'))

  const casesTab = findOne(tree, (element) => element.type === 'button' && element.props.role === 'tab' && textOf(element).includes('事件单'))
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
  assert.equal(env.storage.get('dsh-overwatch.write-token'), 'secret-token')
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
