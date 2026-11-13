import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { apply, inject } from '../src/index.js'
import { OverwatchService } from '../src/service.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-service-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const LIMIT = 1_000_000

function fakePorts() {
  const state = { status: 'running', spent: 0, calls: [] }
  return {
    state,
    swarm: {
      async health() {
        return { ok: true, status: 200, data: { ok: true }, error: null }
      },
      async run() {
        return {
          ok: true,
          status: 200,
          data: {
            runId: 'run-1',
            goal: 'service test',
            status: state.status,
            round: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            budget: {
              limits: { runTokens: LIMIT, runUsd: 0, runWallMs: 0, taskTokens: 1, memberTokens: 1 },
              run: { tokens: state.spent, reservedTokens: 0, calls: 1, usd: 0, reservedUsd: 0, wallMs: 0 },
              tasks: {},
              members: {},
              reservations: 0,
            },
            members: [],
            tasks: [],
            workspace: { conflicts: 0 },
            dispatch: { auto: false, active: 0 },
          },
          error: null,
        }
      },
      async events() {
        return { ok: true, status: 200, data: { events: [] }, error: null }
      },
      async intervene(_runId, body) {
        state.calls.push(body.action)
        if (body.action === 'pause') state.status = 'paused'
        return { ok: true, status: 200, data: { status: state.status }, error: null }
      },
      supports(decision) {
        return decision.target.kind === 'swarm_run'
      },
      async apply(decision, context) {
        await this.intervene('run-1', { action: decision.action === 'throttle' ? 'pause' : decision.action })
        return { ok: true, kind: decision.action, actionId: context.actionId }
      },
      async verify(decision) {
        const expected = decision.action === 'resume' ? 'running' : decision.action === 'abort' ? 'aborted' : 'paused'
        return { ok: state.status === expected, detail: { status: state.status } }
      },
    },
    pressure: {
      async health() {
        return { ok: false, status: 404, data: null, error: 'HTTP 404' }
      },
      async live() {
        return { ok: false, status: 404, data: null, error: 'HTTP 404' }
      },
      supports() {
        return false
      },
    },
    fish: { async overview() { return { ok: false, status: 401, data: null, error: 'HTTP 401' } }, supports() { return false } },
  }
}

function fakeWebServer(origin) {
  return {
    origin,
    getOrigin: () => origin,
    register(route) {
      this.route = route
      return () => {}
    },
  }
}

function fakeCtx(webServer) {
  const registered = []
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
      },
    },
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject() {
      return () => {}
    },
  }
  return {
    ctx,
    registered,
    listeners,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function config(dataDir, fishDir) {
  return resolveConfig({
    storage: { dataDir },
    fish: { dataDir: fishDir ?? '' },
    http: { token: 'secret' },
    sampling: { swarmEventMs: 1_000, swarmSnapshotMs: 1_000, pressureMs: 1_000, fishMs: 1_000 },
    policy: { twoSignalRule: false },
  })
}

function fishFixture() {
  const root = tempDir()
  const source = path.join(root, 'checkpoints', 'fish-a')
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'index.jsonl'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'ck_1',
    createdAt: '2026-11-14T02:00:00.000Z',
    trigger: 'diary',
    files: 2,
    storedBytes: 100,
    pinned: true,
  })}\n`)
  return root
}

test('the service arms one supervisor, lists it, and leaves a readable archive after disarm', async () => {
  const dataDir = tempDir()
  const origin = 'http://127.0.0.1:1'
  const ctx = fakeCtx(fakeWebServer(origin)).ctx
  const ports = fakePorts()
  const service = new OverwatchService({
    ctx,
    config: config(dataDir),
    version: '0.1.0',
    portsFactory: () => ports,
  })
  await service.open()
  const armed = await service.arm({ runId: 'run-1', mode: 'guard' })
  assert.equal(armed.state, 'watching')
  assert.equal(service.listRuns().length, 1)
  assert.equal(service.getRun('run-1').armed, true)
  assert.equal(service.health().runs[0].armed, true)

  await assert.rejects(() => service.arm({ runId: 'run-1' }), error => error.code === 'ALREADY_ARMED')
  const disarmed = await service.disarm('run-1', 'test done')
  assert.equal(disarmed.state, 'disarmed')

  const archived = service.getRun('run-1')
  assert.equal(archived.armed, false)
  assert.equal(archived.state, 'disarmed')
  assert.equal(service.listRuns()[0].armed, false)
  assert.match(service.report('run-1'), /archive/)
  service.close()
})

test('doctor reports data dir, chain, upstreams, fish index and the run', async () => {
  const dataDir = tempDir()
  const fishDir = fishFixture()
  const ctx = fakeCtx(fakeWebServer('http://127.0.0.1:1')).ctx
  const ports = fakePorts()
  const service = new OverwatchService({ ctx, config: config(dataDir, fishDir), version: '0.1.0', portsFactory: () => ports })
  await service.open()
  await service.arm({ runId: 'run-1', mode: 'guard' })
  const doctor = await service.doctor()
  const byId = Object.fromEntries(doctor.checks.map(check => [check.id, check]))
  assert.equal(byId['data-dir'].status, 'pass')
  assert.equal(byId['service-log'].status, 'pass')
  assert.equal(byId.swarm.status, 'pass')
  assert.equal(byId.pressure.status, 'warn')
  assert.equal(byId['fishkeeper-write'].status, 'warn')
  assert.equal(byId['fish-index'].status, 'pass')
  assert.equal(byId['run:run-1'].status, 'pass')
  assert.equal(byId['disk-free'].status, 'pass')
  assert.equal(doctor.ok, true)
  const fish = service.fishIndex()
  assert.equal(fish.sources[0].sourceId, 'fish-a')
  assert.equal(fish.sources[0].checkpoints[0].pinned, true)
  service.close()
})

test('apply registers tools and the HTTP route, then disposes cleanly', async () => {
  const dataDir = tempDir()
  const origin = 'http://127.0.0.1:1'
  const webServer = fakeWebServer(origin)
  const fake = fakeCtx(webServer)
  await apply(fake.ctx, { storage: { dataDir }, http: { token: 'secret' } })
  assert.deepEqual(fake.registered.map(entry => entry.definition.name).sort(), ['watch_arm', 'watch_disarm', 'watch_report', 'watch_status'])
  assert.equal(webServer.route.path, '/overwatch/api')
  assert.equal(webServer.route.kind, 'prefix')
  assert.equal(typeof webServer.route.handler, 'function')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof fake.listeners.get('agent/created'), 'function')
  assert.equal(typeof fake.listeners.get('session/event'), 'function')
  // A listener call with no live run must be a no-op, not a throw.
  assert.doesNotThrow(() => fake.listeners.get('agent/created')({ agent: { id: 'sess_x' } }))
  assert.doesNotThrow(() => fake.listeners.get('session/event')({ id: 'sess_x' }, { type: 'assistant/message' }))
  fake.dispose()
})
