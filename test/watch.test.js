import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { WatchOfficer } from '../src/watch.js'

const config = resolveConfig({
  http: { token: 'secret' },
  supervisor: {
    maxEvidenceCalls: 3,
    wakeTimeoutMs: 5_000,
    maxEvidenceBytes: 8_192,
    agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4_096 },
  },
})

function fakeChildTools() {
  return {
    restricted: null,
    registered: [],
    restrict(filter) {
      this.restricted = filter
    },
    register(definition) {
      this.registered.push(definition)
    },
  }
}

function harness(options = {}) {
  const state = {
    startCalls: [],
    sendCalls: [],
    disposed: false,
    resolveResult: null,
  }
  const activation = {
    childId: 'sess_watch',
    name: 'ow-test',
    result: new Promise(resolve => {
      state.resolveResult = resolve
    }),
    dispose: async () => {
      state.disposed = true
    },
  }
  const childTools = fakeChildTools()
  const agents = new Map()
  const subagents = {
    config: { maxActiveSubagents: { get: () => 8 } },
    namesOf(agent) {
      return { self: agent?.id === 'sess_watch' ? 'ow-test' : 'lead', parent: 'lead' }
    },
    async startActivation(spec) {
      state.startCalls.push(spec)
      agents.set('sess_watch', { id: 'sess_watch', ctx: { tools: childTools } })
      return activation
    },
    async sendMessage(sender, target, content) {
      state.sendCalls.push({ sender, target, content })
      return 'msg_1'
    },
  }
  const ctx = {
    tools: {
      schemas: () => [{ name: 'bash' }, { name: 'write' }, { name: 'watch_arm' }, { name: 'subagent' }],
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agents') return { get: id => agents.get(id) ?? null }
      return undefined
    },
  }
  const calls = { card: [], evidence: [], decide: [] }
  const outcomes = []
  const officer = new WatchOfficer({
    ctx,
    runId: 'run-1',
    name: 'ow-test',
    parentAgent: { id: 'root' },
    config,
    callbacks: {
      card: () => ({ caseId: 'case-1', severity: 'L2' }),
      evidence: (caseId, refs) => {
        calls.evidence.push({ caseId, refs })
        return { items: refs.map(ref => ({ ref })), bytes: 10, truncated: false }
      },
      decide: async (decision, meta) => {
        calls.decide.push({ decision, meta })
        const result = { ok: true, actionId: 'act_1', verified: true, accepted: true }
        outcomes.push(result)
        return result
      },
      record: (type, payload) => calls.record?.push?.({ type, payload }),
    },
  })
  return { officer, state, childTools, subagents, calls, activation }
}

const decision = {
  caseId: 'case-1',
  action: 'coach',
  target: { kind: 'swarm_run', id: 'run-1' },
  params: { runId: 'run-1' },
  evidenceRefs: ['ev-1'],
  reason: 'member state looks stuck for longer than the stall window',
  confidence: 0.82,
}

test('the officer claims only its named child and applies the restriction synchronously', () => {
  const { officer, childTools } = harness()
  const other = { id: 'sess_worker', ctx: { tools: fakeChildTools() } }
  assert.equal(officer.handleAgentCreated(other), false)
  assert.equal(other.ctx.tools.restricted, null)

  const child = { id: 'sess_watch', ctx: { tools: childTools } }
  assert.equal(officer.handleAgentCreated(child), true)
  assert.deepEqual(childTools.restricted, { deny: ['bash', 'write', 'watch_arm', 'subagent'] })
  assert.deepEqual(childTools.registered.map(definition => definition.name).sort(), ['watch_case', 'watch_decide', 'watch_evidence'])
  assert.equal(officer.childId, 'sess_watch')
})

test('a restriction failure fails closed: no card, no start, no decision', async () => {
  const { officer, childTools, state } = harness()
  childTools.restrict = () => {
    throw new Error('restrict exploded')
  }
  const child = { id: 'sess_watch', ctx: { tools: childTools } }
  assert.equal(officer.handleAgentCreated(child), true)
  assert.equal(officer.status().state, 'failed')
  assert.match(String(officer.status().unavailable), /restrict exploded/)
  assert.deepEqual(childTools.registered, [])
  const wake = await officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  assert.equal(wake.status, 'error')
  assert.equal(wake.code, 'WATCH_UNRESTRICTED')
  assert.equal(state.startCalls.length, 0)
  const tools = officer.getDefinitions()
  const decide = tools.find(tool => tool.name === 'watch_decide')
  assert.equal((await decide.execute(decision, { agent: { id: 'sess_watch' } })).code, 'WATCH_UNRESTRICTED')
})

test('a child without a tools service fails closed', async () => {
  const { officer, state } = harness()
  assert.equal(officer.handleAgentCreated({ id: 'sess_watch', ctx: {} }), true)
  assert.equal(officer.status().state, 'failed')
  const wake = await officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  assert.equal(wake.status, 'error')
  assert.equal(wake.code, 'WATCH_UNRESTRICTED')
  assert.equal(state.startCalls.length, 0)
})

test('an empty inherited tool table fails closed instead of trusting an empty deny-list', async () => {
  const { officer, childTools } = harness()
  officer.ctx.tools.schemas = () => []
  assert.equal(officer.handleAgentCreated({ id: 'sess_watch', ctx: { tools: childTools } }), true)
  assert.equal(officer.status().state, 'failed')
  assert.equal(childTools.restricted, null)
})

test('the first wake starts a caller-delivered depth-1 child with the case card', async () => {
  const { officer, state } = harness()
  const waking = officer.wake({ caseId: 'case-1', generation: 1, card: { caseId: 'case-1' }, timeoutMs: 2_000 })
  await tick()
  assert.equal(state.startCalls.length, 1)
  assert.equal(state.startCalls[0].delivery, 'caller')
  assert.equal(state.startCalls[0].maxDepth, 1)
  assert.equal(state.startCalls[0].name, 'ow-test')
  assert.deepEqual(state.startCalls[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4_096 })
  assert.match(state.startCalls[0].prompt[0].text, /case-1/)

  const result = await decideToolCall(officer, decision)
  assert.equal(result.ok, true)
  const outcome = await waking
  assert.equal(outcome.status, 'decided')
  assert.equal(outcome.outcome.accepted, true)
})

test('the resolved decision reaches the executor callback exactly once', async () => {
  const { officer, calls } = harness()
  const waking = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  await tick()
  const accepted = await decideToolCall(officer, decision)
  assert.equal(accepted.ok, true)
  assert.equal(calls.decide.length, 1)
  assert.equal(calls.decide[0].meta.caseId, 'case-1')
  assert.equal(calls.decide[0].decision.action, 'coach')
  const rejected = await decideToolCall(officer, decision)
  assert.ok(rejected.code === 'ALREADY_DECIDED' || rejected.code === 'NO_ACTIVE_CASE')
  await waking
})

test('a second wake uses sendMessage cold resume instead of startActivation', async () => {
  const { officer, state } = harness()
  const first = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  await tick()
  await decideToolCall(officer, decision)
  await first
  assert.equal(officer.childId, 'sess_watch')

  const second = officer.wake({ caseId: 'case-2', generation: 2, card: { caseId: 'case-2' }, timeoutMs: 2_000 })
  await tick()
  assert.equal(state.startCalls.length, 1)
  assert.equal(state.sendCalls.length, 1)
  assert.equal(state.sendCalls[0].target, 'sess_watch')
  assert.match(state.sendCalls[0].content[0].text, /case-2/)
  const outcome = await decideToolCall(officer, { ...decision, caseId: 'case-2' })
  assert.equal(outcome.ok, true)
  await second
})

test('a cold resume with the same child id is restricted again on the new agent object', async () => {
  const { officer, state } = harness()
  const first = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  await tick()
  await decideToolCall(officer, decision)
  await first
  assert.equal(officer.childId, 'sess_watch')

  const resumedTools = fakeChildTools()
  const resumedAgent = { id: 'sess_watch', ctx: { tools: resumedTools } }
  assert.equal(officer.handleAgentCreated(resumedAgent), true)
  assert.deepEqual(resumedTools.restricted, { deny: ['bash', 'write', 'watch_arm', 'subagent'] })
  assert.deepEqual(resumedTools.registered.map(definition => definition.name).sort(), ['watch_case', 'watch_decide', 'watch_evidence'])
  assert.equal(state.startCalls.length, 1)
})

test('tool misuse is rejected: wrong case, wrong reason, wrong confidence, wrong agent', async () => {
  const { officer } = harness()
  const waking = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  await tick()
  const tools = officer.getDefinitions()
  const decide = tools.find(tool => tool.name === 'watch_decide')
  const exec = { agent: { id: 'sess_watch' } }
  assert.equal((await decide.execute({ ...decision, caseId: 'other' }, exec)).code, 'CASE_MISMATCH')
  assert.equal((await decide.execute({ ...decision, reason: 'short' }, exec)).code, 'INVALID_REASON')
  assert.equal((await decide.execute({ ...decision, confidence: 2 }, exec)).code, 'INVALID_CONFIDENCE')
  assert.equal((await decide.execute(decision, { agent: { id: 'other' } })).code, 'WRONG_AGENT')
  const accepted = await decide.execute(decision, exec)
  assert.equal(accepted.ok, true)
  await waking
})

test('the evidence call budget is enforced', async () => {
  const { officer } = harness()
  const waking = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 2_000 })
  await tick()
  const tool = officer.getDefinitions().find(definition => definition.name === 'watch_evidence')
  for (let index = 0; index < 3; index += 1) {
    const result = await tool.execute({ refs: [`ev-${index}`] }, {})
    assert.equal(result.ok, true)
  }
  const limited = await tool.execute({ refs: ['ev-4'] }, {})
  assert.equal(limited.code, 'EVIDENCE_LIMIT')
  await decideToolCall(officer, decision)
  await waking
})

test('a wake without a decision times out and refuses a late decision', async () => {
  const { officer } = harness()
  // The wake timer is unref'd so a shutting-down host can exit; the test must
  // keep one ref'd handle alive itself, or Node 22 resolves the event loop.
  const release = keepAlive(2_000)
  try {
    const waking = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 1_000 })
    await tick()
    const outcome = await waking
    assert.equal(outcome.status, 'timeout')
    assert.equal(officer.timeouts, 1)
    const late = await decideToolCall(officer, decision)
    assert.equal(late.code, 'NO_ACTIVE_CASE')
  } finally {
    release()
  }
})

test('dispose resolves an in-flight wake and disposes the activation', async () => {
  const { officer, state } = harness()
  const waking = officer.wake({ caseId: 'case-1', generation: 1, card: {}, timeoutMs: 5_000 })
  await tick()
  await officer.dispose()
  assert.equal(state.disposed, true)
  const outcome = await waking
  assert.equal(outcome.status, 'disposed')
  assert.equal(officer.status().state, 'stopped')
})

async function decideToolCall(officer, args) {
  const tool = officer.getDefinitions().find(definition => definition.name === 'watch_decide')
  return tool.execute(args, { agent: { id: officer.childId ?? 'sess_watch' } })
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** Keep the event loop alive while a test awaits an unref'd wake timer. */
function keepAlive(ms) {
  const timer = setTimeout(() => {}, ms)
  return () => clearTimeout(timer)
}
