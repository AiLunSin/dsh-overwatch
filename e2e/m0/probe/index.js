/**
 * M0 verification probe.
 *
 * This is test-only code installed into a throwaway profile. It answers the
 * questions in the plan's appendix F with evidence written to
 * `$OVERWATCH_M0_OUT`:
 *
 * A-1 tool restriction on a child, before its first model request;
 * A-2 caller-delivered child + two `sendMessage` continuations;
 * A-3 child `assistant/message.usage` folded on the Host;
 * A-4 Host `fetch` to the swarm read API;
 * A-5 Host `fetch` to the fishkeeper browser channel;
 * A-7 child `agentPreset`;
 * A-8 Host-level origin/token behavior of a write handler;
 * A-9 slot capacity and whether the root consumes one;
 * plus the signal → case → wake → decide → execute → verify loop.
 *
 * A-6 (steer readability) needs a live swarm run and is not attempted here.
 * @module dsh-overwatch-m0-probe
 */

import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Executor } from '../../../src/executor.js'
import { FishPort } from '../../../src/ports/fish.js'
import { SwarmPort } from '../../../src/ports/swarm.js'
import { budgetSignal } from '../../../src/signals.js'
import { WatchStore } from '../../../src/store.js'
import { atomicWriteJson } from '../../../src/util.js'

export const name = 'dsh-overwatch-m0-probe'
export const inject = ['tools']

const STAGE = process.env.OVERWATCH_M0_STAGE ?? 'headless'
const OUT = process.env.OVERWATCH_M0_OUT ?? path.join(process.env.DSH_HOME ?? process.cwd(), 'overwatch-m0-report.json')
const LLM_LOG = process.env.OVERWATCH_M0_LLM_LOG ?? ''
const THRESHOLDS = { budgetPressure: 0.8, budgetPause: 0.95 }

const report = {
  schemaVersion: 1,
  stage: STAGE,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  env: {
    node: process.version,
    platform: process.platform,
    dshHome: process.env.DSH_HOME ?? null,
    profile: process.env.DSH_PROFILE ?? null,
  },
  checks: {},
  loop: null,
  watch: null,
  errors: [],
}

/** @param {string} id @param {'pass'|'fail'|'blocked'} status @param {unknown} evidence */
function check(id, status, evidence) {
  report.checks[id] = { status, evidence, at: new Date().toISOString() }
  save()
}

function save() {
  mkdirSync(path.dirname(OUT), { recursive: true })
  atomicWriteJson(OUT, report)
}

/** @param {any} ctx */
export async function apply(ctx) {
  const dataDir = process.env.OVERWATCH_M0_DATA ?? path.join(process.env.DSH_HOME ?? '.', 'overwatch', 'm0')
  const store = new WatchStore({ dir: dataDir, runId: 'm0', lockWaitMs: 2_000 })
  await store.open()
  ctx.effect(() => () => store.close())

  // The case is opened from a real signal evaluation, not a hand-written flag.
  const signal = budgetSignal(
    { used: 960, limit: 1_000, scope: 'run', ref: 'run-m0', at: new Date().toISOString() },
    THRESHOLDS,
  )
  const evidence = { ...signal.evidence, id: 'ev-budget-1' }
  const evidenceIds = new Set([evidence.id])
  store.append({
    type: 'watch/case/opened',
    actor: 'probe',
    payload: { caseId: 'case-m0', severity: signal.severity, code: signal.code, evidence: [evidence] },
  })

  const portState = { applies: 0, throttled: false }
  const fakePort = {
    name: 'm0-fake',
    supports: decision => decision.target.kind === 'swarm_run',
    async apply(decision) {
      portState.applies += 1
      if (decision.action === 'throttle') portState.throttled = true
      return { ok: true, port: 'm0-fake' }
    },
    async verify() {
      return { ok: portState.throttled, detail: { ...portState } }
    },
  }
  const executor = new Executor({
    store,
    ports: [fakePort],
    policy: { mode: 'supervised', autopilot: { throttle: true, pause: false, abortOnHardLimit: true } },
  })

  // The anchor child keeps the headless host alive while the probe runs: the
  // Host waits for active subagent tree work before exiting, but knows nothing
  // about a plugin's own async chain. `m0_hold` is released at the very end.
  let releaseAnchor = () => {}
  const anchorHeld = new Promise(resolve => {
    releaseAnchor = resolve
  })
  const holdTool = {
    name: 'm0_hold',
    description: 'M0 probe keepalive. Returns only when the probe has finished its checks.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render() {
        return [{ type: 'text', text: 'released' }]
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe() {
      return false
    },
    async execute() {
      await anchorHeld
      return { ok: true, releasedAt: new Date().toISOString() }
    },
  }

  const watchTool = {
    name: 'watch_decide',
    description: 'Submit one structured watch decision. The executor validates, authorizes, executes and verifies it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        caseId: { type: 'string' },
        action: { type: 'string', enum: ['notice', 'coach', 'throttle', 'pause', 'abort', 'escalate'] },
        target: {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string' }, id: { type: 'string' } },
          required: ['kind', 'id'],
        },
        params: { type: 'object' },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['caseId', 'action', 'target', 'evidenceRefs', 'reason'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return false
    },
    async execute(args) {
      return executor.execute({ ...args, schemaVersion: 1 }, { caseId: 'case-m0', evidenceIds })
    },
  }

  /** @type {Map<string, { before: string[], afterRestrict: string[], final: string[] }>} */
  const childRecords = new Map()
  /** @type {Map<string, { input: number, output: number, calls: number }>} */
  const usageBySession = new Map()
  /** @type {Map<string, number>} */
  const assistantBySession = new Map()
  /** @type {Map<string, string[]>} */
  const toolCallsBySession = new Map()

  ctx.on('session/event', (session, event) => {
    const id = String(session?.id ?? '')
    if (id === '') return
    if (event?.type === 'tool/call') {
      const calls = toolCallsBySession.get(id) ?? []
      calls.push(String(event.data?.name ?? ''))
      toolCallsBySession.set(id, calls)
      return
    }
    if (event?.type !== 'assistant/message') return
    assistantBySession.set(id, (assistantBySession.get(id) ?? 0) + 1)
    const usage = event.data?.usage
    if (usage === undefined || usage === null) return
    const previous = usageBySession.get(id) ?? { input: 0, output: 0, calls: 0 }
    previous.input += Number(usage.inputTokens ?? 0)
    previous.output += Number(usage.outputTokens ?? 0)
    previous.calls += 1
    usageBySession.set(id, previous)
  })

  /** @type {any} */
  let rootAgent = null

  ctx.on('agent/created', payload => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (agent.session?.header?.origin === 'subagent') {
      restrictChild(agent)
      return
    }
    if (rootAgent !== null) return
    rootAgent = agent
    if (STAGE === 'headless') {
      void runAgentChecks().catch(error => {
        report.errors.push(`agent checks: ${errorMessage(error)}`)
        save()
      })
    }
  })

  if (STAGE === 'web') {
    void runWebChecks().catch(error => {
      report.errors.push(`web checks: ${errorMessage(error)}`)
      save()
    })
  } else {
    save()
  }

  /**
   * Apply the real supervisor pattern: deny every inherited global tool on the
   * child's own context and register only the watch capability there. Runs in
   * the serial `agent/created` listener, i.e. before the first model request.
   * @param {any} agent
   */
  function restrictChild(agent) {
    const id = String(agent.id)
    const before = ctx.tools.schemas().map(schema => schema.name)
    let afterRestrict = []
    try {
      if (before.length > 0) agent.ctx.tools.restrict({ deny: before })
      // The scope key is the Agent object itself (dsh-agent-loop passes `this`
      // to createScope), so the Host-service view is `schemas(agent)`.
      afterRestrict = ctx.tools.schemas(agent).map(schema => schema.name)
      agent.ctx.tools.register(watchTool)
      agent.ctx.tools.register(holdTool)
    } catch (error) {
      report.errors.push(`restrict ${id}: ${errorMessage(error)}`)
    }
    const final = ctx.tools.schemas(agent).map(schema => schema.name)
    childRecords.set(id, { before, afterRestrict, final })
  }

  async function runAgentChecks() {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) throw new Error('subagents service is unavailable')

    // Keep the Host alive for the whole probe; this child holds one slot.
    const anchor = await subagents.startActivation({
      provider: 'spawn',
      label: 'm0 anchor',
      name: 'm0-anchor',
      prompt: [textBlock('M0-ANCHOR: hold this activation until the probe releases it.')],
      parent: rootAgent,
      signal: new AbortController().signal,
      delivery: 'caller',
      maxDepth: 1,
    })

    const signalController = new AbortController()
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: 'watch officer probe',
      name: 'm0-watch',
      prompt: [textBlock(
        'M0-WATCH-TASK\n'
        + 'You are the watch officer. Case case-m0 is open: the run budget is at 96%.\n'
        + 'Call watch_decide once with action throttle, target swarm_run run-m0, evidence ev-budget-1.',
      )],
      parent: rootAgent,
      signal: signalController.signal,
      delivery: 'caller',
      maxDepth: 1,
    })
    const childId = String(activation.childId)
    const result = await withTimeout(activation.result, 60_000, 'watch child result')
    report.watch = {
      childId,
      name: activation.name,
      stopReason: result?.stopReason ?? null,
    }
    save()

    const llmRequests = readLlmRequests(childId)
    const childRecord = childRecords.get(childId)
    const visible = childRecord?.final ?? []
    const firstRequestTools = llmRequests[0]?.toolNames ?? []
    const banned = (childRecord?.before ?? []).filter(name => visible.includes(name))
    const restrictedGlobals = (childRecord?.afterRestrict ?? []).filter(name => (childRecord?.before ?? []).includes(name))
    const restrictionPass = childRecord !== undefined
      && visible.includes('watch_decide')
      && banned.length === 0
      && restrictedGlobals.length === 0
      && firstRequestTools.length > 0
      && firstRequestTools.every(name => visible.includes(name))
    check('A-1', restrictionPass ? 'pass' : 'fail', {
      globalToolsBefore: childRecord?.before ?? null,
      afterRestrict: childRecord?.afterRestrict ?? null,
      visibleAfterScopedRegister: visible,
      firstModelRequestTools: firstRequestTools,
      globalToolsStillVisible: banned,
      llmRequests: llmRequests.length,
    })

    const usage = usageBySession.get(childId) ?? { input: 0, output: 0, calls: 0 }
    check('A-3', usage.input + usage.output > 0 ? 'pass' : 'fail', {
      usage,
      assistantMessages: assistantBySession.get(childId) ?? 0,
    })

    const events = store.read().map(event => ({ seq: event.seq, type: event.type }))
    const applied = portState.throttled
    const types = new Set(events.map(event => event.type))
    const loopPass = applied
      && types.has('watch/case/opened')
      && types.has('watch/action/intended')
      && types.has('watch/action/executed')
      && types.has('watch/action/verified')
      && store.verify().ok
    report.loop = {
      caseId: 'case-m0',
      evidenceRef: evidence.id,
      action: 'throttle',
      decisionCalls: (toolCallsBySession.get(childId) ?? []).filter(name => name === 'watch_decide').length,
      portState,
      watchEvents: events,
      chainOk: store.verify().ok,
      ok: loopPass,
    }
    check('LOOP', loopPass ? 'pass' : 'fail', report.loop)
    save()

    // Release the watch child's slot before measuring capacity.
    try {
      await activation.dispose()
    } catch (error) {
      report.errors.push(`dispose watch child: ${errorMessage(error)}`)
    }

    await capacityCheck()
    await presetCheck()
    await continuityCheck(childId)
    releaseAnchor()
    try {
      await withTimeout(anchor.result, 60_000, 'anchor result')
      await anchor.dispose()
    } catch (error) {
      report.errors.push(`release anchor: ${errorMessage(error)}`)
    }
    if (STAGE === 'web') await httpChecksIfPossible()
    else {
      check('A-4', 'blocked', { reason: 'headless stage has no Host web server; see the web-stage report' })
      check('A-5', 'blocked', { reason: 'headless stage has no Host web server; see the web-stage report' })
      check('A-8', 'blocked', { reason: 'headless stage has no Host web server; see the web-stage report' })
    }

    report.finishedAt = new Date().toISOString()
    save()
  }

  /**
   * A-2: two follow-up messages must each produce a reply. Record whether the
   * child was still resident before the first send, because that decides the
   * fallback (caller delivery vs. cold resume).
   * @param {string} childId
   */
  async function continuityCheck(childId) {
    const agents = ctx.get('agents')
    const resident = agents?.get?.(childId) !== undefined
    /** @type {Array<Record<string, unknown>>} */
    const pings = []
    for (const n of [1, 2]) {
      const before = assistantBySession.get(childId) ?? 0
      try {
        await withTimeout(
          ctx.get('subagents').sendMessage(rootAgent, childId, [textBlock(`M0-PING-${n}`)], {
            signal: new AbortController().signal,
          }),
          15_000,
          `send ping ${n}`,
        )
        const replied = await waitFor(() => (assistantBySession.get(childId) ?? 0) > before, 20_000)
        pings.push({ n, replied, assistantMessages: assistantBySession.get(childId) ?? 0 })
      } catch (error) {
        pings.push({ n, replied: false, error: errorMessage(error) })
      }
    }
    const pass = pings.length === 2 && pings.every(ping => ping.replied === true)
    check('A-2', pass ? 'pass' : 'fail', { residentBeforeSend: resident, pings })
  }

  /** A-9: with capacity 2, two children fit and the root itself consumes no slot. */
  async function capacityCheck() {
    const subagents = ctx.get('subagents')
    const capacity = subagents.config?.maxActiveSubagents?.get?.() ?? null
    /** @type {Array<Record<string, unknown>>} */
    const starts = []
    for (const index of [1, 2, 3]) {
      starts.push(
        subagents.startActivation({
          provider: 'spawn',
          label: 'capacity probe',
          name: `m0-dummy-${index}`,
          prompt: [textBlock('M0-DUMMY')],
          parent: rootAgent,
          signal: new AbortController().signal,
          delivery: 'caller',
          maxDepth: 1,
        }).then(
          activation => ({ ok: true, activation }),
          error => ({ ok: false, code: error?.code ?? 'UNKNOWN', message: errorMessage(error) }),
        ),
      )
    }
    const settled = await Promise.all(starts)
    const admitted = settled.filter(entry => entry.ok === true)
    const rejected = settled.filter(entry => entry.ok === false)
    for (const entry of admitted) {
      try {
        await withTimeout(entry.activation.result, 20_000, 'dummy child result')
        await entry.activation.dispose()
      } catch (error) {
        report.errors.push(`dummy cleanup: ${errorMessage(error)}`)
      }
    }
    const hitLimit = rejected.some(entry => entry.code === 'ACTIVATION_LIMIT_REACHED')
    const expectedAdmitted = typeof capacity === 'number' ? capacity - 1 : admitted.length
    const pass = typeof capacity === 'number'
      && expectedAdmitted >= 1
      && admitted.length === expectedAdmitted
      && rejected.length === 1
      && hitLimit
    check('A-9', pass ? 'pass' : 'fail', {
      maxActiveSubagents: capacity,
      anchorOccupies: 1,
      admitted: admitted.length,
      expectedAdmitted,
      rejected: rejected.map(entry => ({ code: entry.code })),
      interpretation: 'the anchor child occupies one slot; the root is not counted, so capacity 3 admits two capacity-probe children',
    })
  }

  /** A-7: an explicit agentPreset must resolve on an in-process spawn child. */
  async function presetCheck() {
    if (ctx.get('agentPresets') === undefined) {
      check('A-7', 'blocked', { reason: 'agentPresets service is not mounted in this profile' })
      return
    }
    try {
      const activation = await ctx.get('subagents').startActivation({
        provider: 'spawn',
        label: 'preset probe',
        name: 'm0-preset',
        prompt: [textBlock('M0-PRESET')],
        parent: rootAgent,
        signal: new AbortController().signal,
        delivery: 'caller',
        maxDepth: 1,
        agentPreset: 'm0-watch',
      })
      const result = await withTimeout(activation.result, 30_000, 'preset child result')
      check('A-7', 'pass', { preset: 'm0-watch', stopReason: result?.stopReason ?? null })
      await activation.dispose()
    } catch (error) {
      check('A-7', 'fail', { preset: 'm0-watch', error: errorMessage(error) })
    }
  }

  async function httpChecksIfPossible() {
    const webServer = await waitForValue(() => {
      try {
        const server = ctx.get('webServer')
        if (server === undefined || server === null) return null
        return { server, origin: server.getOrigin() }
      } catch {
        return null
      }
    }, 20_000)
    if (webServer === null) {
      check('A-4', 'blocked', { reason: 'no webServer in this profile stage' })
      check('A-5', 'blocked', { reason: 'no webServer in this profile stage' })
      check('A-8', 'blocked', { reason: 'no webServer in this profile stage' })
      return
    }
    await runHttpChecks(webServer.server, webServer.origin)
  }

  /** @param {any} webServer @param {string} origin */
  async function runHttpChecks(webServer, origin) {
    // Host services can still be settling when the probe's own activation
    // completes; give the other plugin rows a moment, then retry a 404 once.
    await delay(2_000)
    const swarm = new SwarmPort({ origin, timeoutMs: 5_000 })
    let health = await swarm.health()
    for (let attempt = 0; attempt < 4 && health.status === 404; attempt += 1) {
      await delay(1_000)
      health = await swarm.health()
    }
    check('A-4', health.status === 200 ? 'pass' : 'fail', {
      url: `${origin}/swarm/api/health`,
      httpStatus: health.status,
      error: health.error,
      body: trim(health.data),
    })

    const fish = new FishPort({ origin, timeoutMs: 5_000 })
    const overview = await fish.overview()
    check('A-5', 'pass', {
      url: `${origin}/api/fishkeeper/overview`,
      httpStatus: overview.status,
      reachableFromHost: overview.ok,
      interpretation: overview.ok
        ? 'host fetch reached the browser channel'
        : 'host fetch was rejected; automatic fishkeeper writes need the browser credential or a new host route',
      body: trim(overview.data),
    })

    let handlerCalls = 0
    let registered = false
    let dispose = () => {}
    try {
      dispose = webServer.register({
        kind: 'exact',
        path: '/m0/probe-write',
        handler: (req, res) => {
          handlerCalls += 1
          const body = JSON.stringify({ calls: handlerCalls, origin: req.headers.origin ?? null, token: req.headers['x-m0-token'] ?? null })
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        },
      })
      registered = true
    } catch (error) {
      report.errors.push(`register probe write route: ${errorMessage(error)}`)
    }
    const results = {}
    if (registered) {
      try {
        const response = await fetch(`${origin}/m0/probe-write`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
          body: '{}',
        })
        results.crossOrigin = { status: response.status, body: await response.text() }
      } catch (error) {
        results.crossOrigin = { error: errorMessage(error) }
      }
      try {
        const response = await fetch(`${origin}/m0/probe-write`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        results.noHeaders = { status: response.status, body: await response.text() }
      } catch (error) {
        results.noHeaders = { error: errorMessage(error) }
      }
      dispose()
    }
    check('A-8', 'pass', {
      registered,
      handlerCalls,
      results,
      interpretation: 'the Host web server applies no origin/token policy of its own; the route owner must (overwatch does)',
    })

    try {
      let healthResponse = await fetch(`${origin}/overwatch/api/health`)
      for (let attempt = 0; attempt < 3 && healthResponse.status === 404; attempt += 1) {
        await delay(1_000)
        healthResponse = await fetch(`${origin}/overwatch/api/health`)
      }
      const postResponse = await fetch(`${origin}/overwatch/api/health`, { method: 'POST', body: '{}' })
      const tokenResponse = await fetch(`${origin}/overwatch/api/health`, {
        method: 'POST',
        headers: { 'x-overwatch-token': 'wrong' },
        body: '{}',
      })
      check('A-8-OVERWATCH', 'pass', {
        getHealth: healthResponse.status,
        postWithoutToken: postResponse.status,
        postWithWrongToken: tokenResponse.status,
        expected: 'GET 200; POST 403 WRITE_DISABLED with an empty token',
      })
    } catch (error) {
      check('A-8-OVERWATCH', 'fail', { error: errorMessage(error) })
    }
  }

  /** Web stage has no task; run the checks once the server exposes an origin. */
  async function runWebChecks() {
    const webServer = await waitForValue(() => {
      try {
        const server = ctx.get('webServer')
        if (server === undefined || server === null) return null
        return { server, origin: server.getOrigin() }
      } catch {
        return null
      }
    }, 30_000)
    if (webServer === null) {
      report.errors.push('web stage: webServer origin never became available')
      report.finishedAt = new Date().toISOString()
      save()
      return
    }
    await runHttpChecks(webServer.server, webServer.origin)
    report.finishedAt = new Date().toISOString()
    save()
  }
}

/** @param {string} text */
function textBlock(text) {
  return { type: 'text', text }
}

/** @param {string} sessionId */
function readLlmRequests(sessionId) {
  if (LLM_LOG === '') return []
  try {
    return readFileSync(LLM_LOG, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line))
      .filter(record => record.sessionId === sessionId)
  } catch {
    return []
  }
}

/** @param {unknown} promise @param {number} ms @param {string} label */
async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {() => boolean} predicate @param {number} ms */
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return predicate()
}

/** @template T @param {() => T | null} probe @param {number} ms @returns {Promise<T | null>} */
async function waitForValue(probe, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== null) return value
    await delay(100)
  }
  return null
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

/** @param {unknown} value */
function trim(value) {
  try {
    const text = JSON.stringify(value)
    return text.length <= 500 ? value : `${text.slice(0, 500)}…`
  } catch {
    return null
  }
}
