import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { registerTools } from '../src/tools.js'

function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      tools: {
        register(definition, options) {
          registered.push({ definition, options })
        },
      },
    },
  }
}

function fakeService() {
  const calls = []
  return {
    calls,
    async arm(input) {
      calls.push(['arm', input.runId, input.mode, input.parentAgent?.id])
      return { runId: input.runId, mode: input.mode ?? 'guard', state: 'watching', armed: true, armedAt: '2026-11-14T02:00:00.000Z', reserve: 0 }
    },
    async disarm(runId, reason) {
      calls.push(['disarm', runId, reason])
      return { runId, closedCases: [] }
    },
    getRun(runId) {
      return runId === 'run-1' ? { runId, armed: true, state: 'watching', cases: { open: 0 } } : null
    },
    listRuns() {
      return [{ runId: 'run-1', armed: true }]
    },
    health() {
      return { ok: true, version: '0.1.0', mode: 'guard' }
    },
    report(runId) {
      return `# report ${runId}`
    },
    cases() {
      return []
    },
  }
}

const config = resolveConfig({ http: { token: 'secret' } })

function setup() {
  const { ctx, registered } = fakeCtx()
  const service = fakeService()
  registerTools(ctx, service, config)
  const byName = Object.fromEntries(registered.map(entry => [entry.definition.name, entry]))
  return { service, registered, byName }
}

const ROOT = { agent: { id: 'root', session: { header: { origin: 'user' } } } }
const CHILD = { agent: { id: 'child', session: { header: { origin: 'subagent' } } } }

test('four root-only tools are registered with a working when predicate', () => {
  const { byName } = setup()
  assert.deepEqual(Object.keys(byName).sort(), ['watch_arm', 'watch_disarm', 'watch_report', 'watch_status'])
  for (const entry of Object.values(byName)) {
    assert.equal(entry.options.when({ agent: ROOT.agent }), true)
    assert.equal(entry.options.when({ agent: CHILD.agent }), false)
    assert.equal(entry.definition.isConcurrencySafe(), entry.definition.name === 'watch_status' || entry.definition.name === 'watch_report')
  }
})

test('the root can arm, and the tool result is JSON-renderable', async () => {
  const { service, byName } = setup()
  const result = await byName.watch_arm.definition.execute({ runId: 'run-1', mode: 'guard' }, ROOT)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'watching')
  assert.deepEqual(service.calls[0], ['arm', 'run-1', 'guard', 'root'])
  const rendered = byName.watch_arm.definition.output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /watching/)
})

test('a subagent cannot arm or disarm even if it reaches the handler', async () => {
  const { service, byName } = setup()
  const arm = await byName.watch_arm.definition.execute({ runId: 'run-1' }, CHILD)
  assert.equal(arm.ok, false)
  assert.equal(arm.code, 'ROOT_ONLY')
  const disarm = await byName.watch_disarm.definition.execute({ runId: 'run-1' }, CHILD)
  assert.equal(disarm.code, 'ROOT_ONLY')
  assert.equal(service.calls.length, 0)
})

test('supervised arm forwards the live root agent as the watch officer parent', async () => {
  const { service, byName } = setup()
  const result = await byName.watch_arm.definition.execute({ runId: 'run-1', mode: 'supervised' }, ROOT)
  assert.equal(result.ok, true)
  assert.equal(service.calls[0][2], 'supervised')
  assert.equal(service.calls[0][3], 'root')
})

test('supervised arm without a root agent is rejected before the service call', async () => {
  const { service, byName } = setup()
  const result = await byName.watch_arm.definition.execute({ runId: 'run-1', mode: 'supervised' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_REQUIRED')
  assert.equal(service.calls.length, 0)
})

test('status and report read through the service without arming anything', async () => {
  const { service, byName } = setup()
  const status = await byName.watch_status.definition.execute({}, ROOT)
  assert.equal(status.ok, true)
  assert.equal(status.runs[0].runId, 'run-1')
  const one = await byName.watch_status.definition.execute({ runId: 'run-1' }, ROOT)
  assert.equal(one.data.state, 'watching')
  const report = await byName.watch_report.definition.execute({ runId: 'run-1' }, ROOT)
  assert.equal(report.format, 'md')
  assert.match(report.report, /report run-1/)
  assert.equal(service.calls.length, 0)
})
