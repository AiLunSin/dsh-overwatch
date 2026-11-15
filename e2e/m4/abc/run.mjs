/**
 * A/B/C supervision comparison over a real local dsh-swarm.
 *
 * Groups:
 * - A: no overwatch at all (baseline).
 * - B: in-process overwatch, `mode: guard` (deterministic budget autopilot).
 * - C: real headless DSH host, `mode: supervised`, real `deepseek-flash` watch.
 *
 * Scenarios (injected through the real swarm API / real budget ledger):
 * - I-1 budget cliff: 81% → 96% → 102% of a 100k token run.
 * - I-3 failure loop: scripted pressure telemetry reports 5 consecutive failures.
 * - I-4 idle member: the dispatched child never produces another event.
 *
 * Swarm members are a scripted hanging runner (no model cost). Only the C watch
 * officer calls a real model. Member pressure is scripted because fake members
 * have no real session to measure.
 *
 * Usage: node e2e/m4/abc/run.mjs [--groups A,B,C] [--scenarios I-1,I-3,I-4]
 *        [--repeats 3] [--max-cost-cny 20] [--keep]
 * @module dsh-overwatch/e2e/m4/abc
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseChain } from '../../../src/store.js'
import { resolveConfig as resolveOverwatchConfig } from '../../../src/config.js'
import { OverwatchService } from '../../../src/service.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const swarmRoot = process.env.DSH_SWARM_ROOT ?? path.resolve(repoRoot, '..', 'em', 'dsh-swarm')
const resultsDir = path.join(repoRoot, 'e2e', 'm4', 'abc', 'results')

const SWARM_TOKEN = 'abc-swarm-token'
const HTTP_TOKEN = 'abc-http-token'
const RUN_BUDGET = 100_000
const STALL_MS = 3_000
const GROUPS = ['A', 'B', 'C']
const SCENARIOS = ['I-1', 'I-3', 'I-4']

const keep = process.argv.includes('--keep')
const groups = listArg('groups', GROUPS.join(','))
const scenarios = listArg('scenarios', SCENARIOS.join(','))
const repeats = intArg('repeats', 3)
const maxCostCny = Number(valueArg('max-cost-cny', '20'))
const priceInputCnyPerM = Number(valueArg('price-input-cny-per-m', '4'))
const priceOutputCnyPerM = Number(valueArg('price-output-cny-per-m', '16'))

for (const group of groups) if (!GROUPS.includes(group)) fatal(`unknown group ${group}`)
for (const scenario of scenarios) if (!SCENARIOS.includes(scenario)) fatal(`unknown scenario ${scenario}`)
if (!Number.isSafeInteger(repeats) || repeats < 1) fatal('--repeats must be a positive integer')
if (!Number.isFinite(maxCostCny) || maxCostCny <= 0) fatal('--max-cost-cny must be positive')

const swarmConfigModule = await importPath(path.join(swarmRoot, 'src', 'config.js'))
const swarmServiceModule = await importPath(path.join(swarmRoot, 'src', 'service.js'))
const swarmHttpModule = await importPath(path.join(swarmRoot, 'src', 'http.js'))
const resolveSwarmConfig = swarmConfigModule.resolveConfig
const { SwarmService } = swarmServiceModule
const { createNodeHandler } = swarmHttpModule

/** @type {Array<any>} */
const rows = []
let spendCny = 0
let stopC = false
let skipped = false

async function main() {
  const startedAt = new Date()
  sweepTempDirs()
  rmSync(resultsDir, { recursive: true, force: true })
  mkdirSync(resultsDir, { recursive: true })
  if (groups.includes('C')) ensureDesktop()
  console.log(`abc: groups=${groups.join(',')} scenarios=${scenarios.join(',')} repeats=${repeats} cap=¥${maxCostCny}`)
  for (const group of groups) {
    for (const scenario of scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        if (group === 'C' && stopC) {
          skipped = true
          console.log(`abc: skip C ${scenario} #${repeat} (cost cap reached)`)
          continue
        }
        console.log(`abc: run ${group} ${scenario} #${repeat}`)
        let row
        try {
          row = await runOne({ group, scenario, repeat })
        } catch (error) {
          row = failedRow({ group, scenario, repeat, error })
        }
        rows.push(row)
        if (group === 'C' && row.wake !== null) {
          spendCny += estimateCny(row.wake.tokens)
          if (spendCny >= maxCostCny) {
            stopC = true
            console.log(`abc: cost cap reached at ¥${spendCny.toFixed(4)}`)
          }
        }
        publish({ startedAt, finishedAt: null })
        console.log(`abc: ${row.pass ? 'PASS' : 'FAIL'} ${group} ${scenario} #${repeat} ${row.note}`)
      }
    }
  }
  const finishedAt = new Date()
  const report = publish({ startedAt, finishedAt })
  console.log('')
  console.log(markdown(report))
  process.exit(rows.every(row => row.pass) ? 0 : 1)
}

/**
 * @param {{ group: string, scenario: string, repeat: number }} input
 */
async function runOne(input) {
  const { group, scenario, repeat } = input
  // Isolate the signal under test: the failure-loop scenario must not be
  // pre-empted by a generic "quiet run" case, and the idle scenario needs a
  // silence long enough to be a real anomaly rather than startup latency.
  const stallMs = scenario === 'I-4' ? 12_000 : 60_000
  const temp = mkdtempSync(path.join(os.tmpdir(), `overwatch-abc-${group}-${scenario}-`))
  const repo = await makeRepo(path.join(temp, 'repo'))
  const pressure = new Map()
  /** @type {any} */
  let swarm = null
  /** @type {any} */
  let server = null
  /** @type {any} */
  let guard = null
  /** @type {any} */
  let host = null
  const row = baseRow(input)
  try {
    swarm = new SwarmService({
      config: resolveSwarmConfig({
        dataDir: path.join(temp, 'swarm-data'),
        members: 2,
        budget: { tokens: RUN_BUDGET, usd: 0, wallMs: 0, hardStop: false },
        taskBudget: { tokens: 1_000_000 },
        memberBudget: { tokens: 1_000_000 },
        orchestrator: { autoStart: true, tickMs: 600_000 },
        preflight: { enabled: false, minFreeMb: 0 },
        workspace: { enabled: true, root: '', diskThresholdMb: 0, keep: false, maxConcurrent: 2 },
        gate: { commands: ['node -e "process.exit(0)"'], autoDetect: false, timeoutMs: 30_000 },
        dispatch: { autoCommit: true, timeoutMs: 600_000, auto: false },
        review: { reviewersPerPatch: 1, quorum: 0.5, requireEvidence: true },
        convergence: { stallMs: 3_600_000 },
        http: { enabled: true, token: SWARM_TOKEN },
      }),
      baseDir: path.join(temp, 'swarm-base'),
    })
    swarm.runner = new HangingRunner()
    await swarm.open()
    const created = await swarm.createRun({
      goal: `A/B/C ${scenario} ${group}`,
      repo,
      mode: 'swarm',
      members: 2,
      budget: { tokens: RUN_BUDGET },
    }, { agent: { id: 'abc-parent' } })
    row.runId = created.swarmId
    row.childId = await dispatchHanging(swarm, created)
    const port = await freePort()
    server = await startServer({ swarm, pressure, port })

    if (group === 'B') {
      guard = await startGuard({ runId: row.runId, temp, port, stallMs })
    } else if (group === 'C') {
      host = await startHost({ temp, port, runId: row.runId, scenario, stallMs })
    }

    if (group === 'C') {
      await waitForArmed(host.dataDir, row.runId, 90_000)
      row.armed = readWatch(host.dataDir, row.runId).events.find(event => event.type === 'watch/armed')?.payload ?? null
    }

    const injection = await inject({ scenario, swarm, childId: row.childId, pressure })
    row.injectedAt = new Date(injection.injectedAt).toISOString()
    row.referenceAt = new Date(injection.referenceAt).toISOString()

    if (group === 'B') {
      await delay(scenario === 'I-4' ? stallMs + 5_000 : 7_000)
      await guard.disarm(row.runId, 'abc run complete')
      guard.close()
      guard = null
    } else if (group === 'C') {
      const settled = await waitForWake(host.dataDir, row.runId, 150_000)
      row.wakeSettled = settled
      writeFileSync(host.doneFile, 'done\n', 'utf8')
      await waitForExit(host.child, 45_000)
    } else {
      await delay(scenario === 'I-4' ? stallMs + 5_000 : 9_000)
    }

    row.stallMs = stallMs

    row.final = finalState(swarm, row.runId)
    const dataDir = group === 'C' ? host.dataDir : group === 'B' ? path.join(temp, 'overwatch') : null
    row.watch = dataDir === null ? null : readWatch(dataDir, row.runId)
    if (row.watch !== null) {
      row.cases = row.watch.cases
      row.detection = detectionOf(row.watch.events, injection.referenceAt)
      row.actions = actionsOf(row.watch.events)
      row.wake = wakeOf(row.watch.events)
      if (group === 'C') row.hostLog = host.log().slice(-4_000)
    }
    row.wallMs = Date.now() - Date.parse(row.startedAt)
    row.verdict = verdict(group, scenario, row)
    row.pass = row.verdict.pass
    row.note = row.verdict.note
    archiveRun({ temp, group, scenario, repeat, runId: row.runId, dataDir })
    return row
  } finally {
    if (guard !== null) {
      try {
        await guard.disarm(row.runId, 'abc cleanup')
      } catch {
        // already disarmed
      }
      guard.close()
    }
    if (host !== null) {
      writeFileSync(host.doneFile, 'done\n', 'utf8')
      await waitForExit(host.child, 15_000)
    }
    if (server !== null) await server.close()
    if (swarm !== null) {
      try {
        await swarm.close()
      } catch {
        // best effort
      }
    }
    if (keep) console.log(`abc: kept ${temp}`)
    else {
      try {
        rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch (error) {
        console.error(`abc: could not remove ${temp}: ${messageOf(error)}`)
      }
    }
  }
}

/** Copy the per-run evidence next to the report. */
function archiveRun({ temp, group, scenario, repeat, runId, dataDir }) {
  const dest = path.join(resultsDir, 'runs', `${group}-${scenario}-${repeat}`)
  mkdirSync(dest, { recursive: true })
  if (dataDir !== null) {
    copyIf(path.join(dataDir, 'runs', runId, 'watch.jsonl'), path.join(dest, 'watch.jsonl'))
    copyIf(path.join(dataDir, 'runs', runId, 'cases'), path.join(dest, 'cases'))
  }
  const swarmRun = path.join(temp, 'swarm-base', 'runs', runId)
  copyIf(path.join(swarmRun, 'events.jsonl'), path.join(dest, 'swarm-events.jsonl'))
  try {
    for (const name of readdirSync(swarmRun)) {
      if (name.endsWith('.json')) copyIf(path.join(swarmRun, name), path.join(dest, name))
    }
  } catch {
    // no extra snapshot files
  }
  copyIf(path.join(temp, 'host.log'), path.join(dest, 'host.log'))
}

/** @param {string} from @param {string} to */
function copyIf(from, to) {
  if (existsSync(from)) cpSync(from, to, { recursive: true })
}

/** Start the real swarm HTTP surface plus scripted pressure telemetry. */
async function startServer({ swarm, pressure, port }) {
  const handler = createNodeHandler(swarm, { token: SWARM_TOKEN })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/swarm/api')) {
      void handler(req, res)
      return
    }
    if (url.pathname === '/api/dsh-pressure/health') {
      writeJson(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/api/dsh-pressure/live') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const state = pressure.get(sessionId) ?? { pressure: 0.42, failures: 0 }
      writeJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          context: { pressure: state.pressure },
          tools: { failures: state.failures, repeats: 0 },
          tokens: { total: 1_234 },
        },
      })
      return
    }
    writeJson(res, 404, { error: { code: 'NOT_FOUND', message: url.pathname } })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    close: () => new Promise(resolve => server.close(() => resolve(undefined))),
  }
}

/** Real overwatch in guard mode, no host, no model. */
async function startGuard({ runId, temp, port, stallMs }) {
  const config = resolveOverwatchConfig({
    enabled: true,
    mode: 'guard',
    http: { enabled: true, token: HTTP_TOKEN },
    ports: { origin: `http://127.0.0.1:${port}`, swarmToken: SWARM_TOKEN },
    storage: { dataDir: path.join(temp, 'overwatch') },
    sampling: { swarmEventMs: 200, swarmSnapshotMs: 200, pressureMs: 200, fishMs: 60_000, staleMs: 5_000, requestTimeoutMs: 1_000, maxInflight: 2 },
    thresholds: { stallMs },
    policy: { throttleMinutes: 1, autopilot: { throttle: true, pause: true, pauseOnHardLimit: true, abortOnHardLimit: true } },
  })
  const service = new OverwatchService({
    ctx: { get: () => undefined },
    config,
    version: 'abc',
    logger: { warn: message => console.error(`abc[guard]: ${message}`) },
  })
  await service.open()
  await service.arm({ runId, mode: 'guard' })
  return service
}

/** @param {string} source @param {string} dest @param {string[]} names */
function copyBundle(source, dest, names) {
  mkdirSync(dest, { recursive: true })
  for (const name of names) {
    const from = path.join(source, name)
    if (existsSync(from)) cpSync(from, path.join(dest, name), { recursive: true })
  }
}

/** Real headless host with the overwatch plugin and a real watch route. */
async function startHost({ temp, port, runId, scenario, stallMs }) {
  const home = path.join(temp, 'home')
  const dataDir = path.join(home, 'overwatch')
  const doneFile = path.join(temp, 'done.flag')
  mkdirSync(home, { recursive: true })
  const credentialFile = path.join(process.env.OVERWATCH_ABC_REAL_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(credentialFile)) throw new Error(`no credentials file at ${credentialFile}; C needs the real provider`)
  copyFileSync(credentialFile, path.join(home, '.credentials.yaml'))
  createProfile({ home, dataDir, port, stallMs })
  const logPath = path.join(temp, 'host.log')
  const child = spawn(executable, ['--expose-internals', cli, '--profile', profileName, 'ABC-ROOT: arm supervised, wait for the done file, then disarm.'], {
    cwd: path.join(temp, 'repo'),
    env: {
      ...cleanEnv(),
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
      OVERWATCH_ABC_RUN_ID: runId,
      OVERWATCH_ABC_DONE: doneFile,
      OVERWATCH_ABC_LLM_LOG: path.join(temp, 'llm.jsonl'),
      OVERWATCH_ABC_WATCH: 'real',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(String(chunk)))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  child.once('exit', () => {
    try {
      writeFileSync(logPath, `--- scenario ${scenario} ---\n--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}\n`, 'utf8')
    } catch {
      // evidence only
    }
  })
  return {
    child,
    home,
    dataDir,
    doneFile,
    log: () => {
      try {
        return readFileSync(logPath, 'utf8') ?? ''
      } catch {
        return `${stdout.join('')}\n${stderr.join('')}`
      }
    },
  }
}

function createProfile({ home, dataDir, port, stallMs }) {
  profileName = `abc-${Date.now().toString(36)}`
  setHome(home)
  mustRun(['--profile', profileName, '--from-default-profile', 'headless', '--dump-config'])
  const profileDir = path.join(home, 'profiles', profileName)
  const nodeModules = path.join(profileDir, 'node_modules')
  // Copy the two local bundles instead of `plugin add`: pnpm's store-project
  // symlink cannot be created in this environment (EBUSY even unsandboxed).
  // Both packages are self-contained, so a plain copy resolves identically.
  copyBundle(repoRoot, path.join(nodeModules, 'dsh-overwatch'), ['package.json', 'src', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg'])
  copyBundle(path.join(repoRoot, 'e2e', 'm4', 'abc', 'fake-llm'), path.join(nodeModules, 'dsh-fake-llm-abc'), ['package.json', 'index.js', 'cordis.patch.yml'])
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    'dsh-overwatch',
    'dsh-fake-llm-abc',
  ]
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# A/B/C comparison profile. Test values only; the real account credential',
    '# is copied into the throwaway DSH_HOME and never printed.',
    '- insert:',
    '    - id: credentials-local',
    "      name: '@deepseek-ai/dsh-credentials-local'",
    '    - id: authorization',
    "      name: '@deepseek-ai/dsh-authorization'",
    '    - id: deepseek-account',
    "      name: '@deepseek-ai/dsh-deepseek-account'",
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- id: subagent',
    '  config:',
    '    maxActiveSubagents: 3',
    '- id: dsh-overwatch',
    '  config:',
    '    enabled: true',
    '    mode: supervised',
    '    http:',
    `      token: ${HTTP_TOKEN}`,
    '    ports:',
    `      origin: http://127.0.0.1:${port}`,
    `      swarmToken: ${SWARM_TOKEN}`,
    '    storage:',
    `      dataDir: '${dataDir.replaceAll('\\', '/')}'`,
    '    sampling:',
    '      swarmEventMs: 200',
    '      swarmSnapshotMs: 200',
    '      pressureMs: 200',
    '      fishMs: 60000',
    '      staleMs: 5000',
    '      requestTimeoutMs: 1000',
    '      maxInflight: 2',
    '    thresholds:',
    `      stallMs: ${stallMs}`,
    '    supervisor:',
    '      maxWakes: 1',
    '      maxWakesPerHour: 1',
    '      wakeTimeoutMs: 120000',
    '      maxEvidenceCalls: 2',
    '      maxTokensPerWake: 20000',
    '      agentOptions:',
    '        provider: deepseek-account',
    '        model: deepseek-flash',
    '        reasoningEffort: off',
    '        maxTokens: 2048',
    '    policy:',
    '      twoSignalRule: true',
    '      throttleMinutes: 1',
    '      autopilot:',
    '        throttle: false',
    '        pause: false',
    '        pauseOnHardLimit: false',
    '        abortOnHardLimit: true',
  ].join('\n') + '\n', 'utf8')
}

/** Dispatch one task to a hanging child so the run has a real childId mapping. */
async function dispatchHanging(swarm, created) {
  const worker = created.members.find(member => member.role === 'worker') ?? created.members[0]
  const { task } = await swarm.createTask(created.swarmId, {
    title: 'ABC injected task',
    acceptance: ['abc gate passes'],
    files: ['src/abc.js'],
  })
  await swarm.advertiseTask(created.swarmId, task.id)
  await swarm.awardTask(created.swarmId, task.id, { memberId: worker.id, force: true, reason: 'ABC injection' })
  const dispatched = await swarm.dispatchTask(created.swarmId, task.id, { memberId: worker.id, fence: 1, wait: false })
  return dispatched.childId
}

/**
 * Inject the scenario. Returns the wall-clock anchors used for latency.
 * @param {{ scenario: string, swarm: any, childId: string, pressure: Map<string, { pressure: number, failures: number }> }} input
 */
async function inject(input) {
  const { scenario, swarm, childId, pressure } = input
  if (scenario === 'I-1') {
    await delay(800)
    const referenceAt = Date.now()
    await swarm.recordUsage(childId, { inputTokens: 81_000, outputTokens: 0 })
    await delay(1_800)
    await swarm.recordUsage(childId, { inputTokens: 15_000, outputTokens: 0 })
    await delay(1_800)
    await swarm.recordUsage(childId, { inputTokens: 6_000, outputTokens: 0 })
    return { injectedAt: referenceAt, referenceAt }
  }
  if (scenario === 'I-3') {
    await delay(800)
    pressure.set(childId, { pressure: 0.55, failures: 5 })
    return { injectedAt: Date.now(), referenceAt: Date.now() }
  }
  // I-4: the silent window starts after the last dispatch event.
  const referenceAt = Date.now()
  return { injectedAt: referenceAt, referenceAt }
}

/** Wait until the host's overwatch log shows the supervised arm. */
async function waitForArmed(dataDir, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = readJsonl(path.join(dataDir, 'runs', runId, 'watch.jsonl'))
    if (events.some(event => event.type === 'watch/armed')) return
    await delay(300)
  }
  throw new Error(`run ${runId} was not armed within ${timeoutMs}ms`)
}

/** Wait until the watch wake settles (decision, rejection, timeout or degradation). */
async function waitForWake(dataDir, runId, timeoutMs) {
  const settledTypes = new Set(['watch/decision', 'watch/decision/rejected', 'watch/wake/timeout', 'watch/degraded'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = readJsonl(path.join(dataDir, 'runs', runId, 'watch.jsonl'))
    const settled = events.find(event => settledTypes.has(event.type))
    if (settled !== undefined) return settled.type
    await delay(500)
  }
  return 'timeout'
}

/** @param {any} swarm @param {string} runId */
function finalState(swarm, runId) {
  try {
    const snapshot = swarm.snapshot(runId, false)
    const ledger = snapshot.budget?.run ?? {}
    const limit = Number(snapshot.budget?.limits?.runTokens ?? 0)
    const spent = Number(ledger.tokens ?? 0) + Number(ledger.reservedTokens ?? 0)
    return { status: String(snapshot.status ?? 'unknown'), spent, limit, ratio: limit > 0 ? spent / limit : 0 }
  } catch (error) {
    return { status: 'unavailable', spent: 0, limit: RUN_BUDGET, ratio: 0, error: messageOf(error) }
  }
}

/** @param {string} dataDir @param {string} runId */
function readWatch(dataDir, runId) {
  const dir = path.join(dataDir, 'runs', runId)
  const watchFile = path.join(dir, 'watch.jsonl')
  const events = readJsonl(watchFile)
  let chain = { ok: events.length > 0, count: events.length, error: events.length > 0 ? null : 'watch log is missing' }
  try {
    const parsed = parseChain(readFileSync(watchFile, 'utf8'), runId)
    chain = {
      ok: parsed.error === null,
      count: parsed.events.length,
      error: parsed.error === null ? null : `${parsed.error.code} at line ${parsed.error.line}`,
    }
  } catch (error) {
    chain = { ok: false, count: 0, error: messageOf(error) }
  }
  return { events, cases: readCases(dir), chain }
}

/** @param {string} dir */
function readCases(dir) {
  const casesDir = path.join(dir, 'cases')
  let names = []
  try {
    names = readdirSync(casesDir)
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        return JSON.parse(readFileSync(path.join(casesDir, name), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(record => record !== null)
}

/** @param {any[]} events @param {number} since */
function detectionOf(events, since) {
  const opened = events.find(event => event.type === 'watch/case/opened' && Date.parse(event.at) >= since)
  if (opened !== undefined) {
    return {
      latencyMs: Date.parse(opened.at) - since,
      at: opened.at,
      caseId: opened.payload?.caseId ?? null,
      code: opened.payload?.code ?? null,
      severity: opened.payload?.severity ?? null,
      source: 'case',
    }
  }
  // The deterministic guard can act on a budget threshold before a case card
  // is persisted; fall back to the first executed action for those runs.
  const action = events.find(event => event.type === 'watch/action/executed' && Date.parse(event.at) >= since)
  if (action !== undefined) {
    return {
      latencyMs: Date.parse(action.at) - since,
      at: action.at,
      caseId: null,
      code: action.payload?.kind ?? 'action',
      severity: null,
      source: 'action',
    }
  }
  return { latencyMs: null, at: null, caseId: null, code: null, severity: null, source: null }
}

/** @param {any[]} events */
function actionsOf(events) {
  return events
    .filter(event => event.type === 'watch/action/executed')
    .map(event => ({
      kind: event.payload?.kind ?? null,
      ok: event.payload?.ok !== false,
      at: event.at,
      actionId: event.payload?.actionId ?? null,
    }))
}

/** @param {any[]} events */
function wakeOf(events) {
  const wakes = events.filter(event => event.type === 'watch/wake').length
  if (wakes === 0) return null
  const usage = events.filter(event => event.type === 'watch/usage').at(-1)?.payload ?? null
  const decision = events.filter(event => event.type === 'watch/decision').at(-1)?.payload ?? null
  return {
    wakes,
    tokens: Number(usage?.spent ?? 0),
    calls: Number(usage?.calls ?? 0),
    action: decision?.action ?? null,
    accepted: decision?.accepted ?? null,
    reason: decision?.reason ?? null,
  }
}

/**
 * @param {string} group
 * @param {string} scenario
 * @param {any} row
 */
function verdict(group, scenario, row) {
  if (group === 'A') {
    return { pass: true, note: `baseline: no supervision, status=${row.final.status}, ratio=${row.final.ratio.toFixed(3)}` }
  }
  if (scenario === 'I-1') {
    const stopped = row.final.status === 'paused' || row.final.status === 'aborted'
    const over = row.final.ratio > 1.05
    return {
      pass: stopped && !over,
      note: `status=${row.final.status} ratio=${row.final.ratio.toFixed(3)} detection=${formatMs(row.detection?.latencyMs)} actions=${row.actions.map(action => action.kind).join('|') || 'none'}`,
    }
  }
  const budgetMs = scenario === 'I-3' ? 5_000 : (row.stallMs ?? STALL_MS) + 3_000
  const detected = row.detection?.latencyMs !== null && row.detection?.latencyMs !== undefined && row.detection.latencyMs <= budgetMs
  const acted = group === 'C' ? row.actions.length > 0 : true
  return {
    pass: detected && acted,
    note: `detection=${formatMs(row.detection?.latencyMs)} case=${row.detection?.code ?? 'none'} actions=${row.actions.map(action => action.kind).join('|') || 'none'}`,
  }
}

function publish({ startedAt, finishedAt }) {
  const report = {
    schemaVersion: 1,
    stage: 'm4-abc',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt === null ? null : finishedAt.toISOString(),
    config: {
      groups,
      scenarios,
      repeats,
      runBudgetTokens: RUN_BUDGET,
      stallMs: { 'I-1': 60_000, 'I-3': 60_000, 'I-4': 12_000 },
      maxCostCny,
      pricing: { inputCnyPerM: priceInputCnyPerM, outputCnyPerM: priceOutputCnyPerM, method: 'all watch tokens priced at the output rate (upper bound)' },
      swarmRoot,
      members: 'scripted hanging runner (no model calls)',
      pressure: 'scripted per fake member child',
    },
    spendCny: Number(spendCny.toFixed(4)),
    skippedC: skipped,
    rows,
  }
  writeFileSync(path.join(resultsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(resultsDir, 'abc.md'), `${markdown(report)}\n`, 'utf8')
  return report
}

/** @param {any} report */
function markdown(report) {
  const lines = [
    '# A/B/C supervision comparison',
    '',
    `- groups: ${report.config.groups.join(', ')} · scenarios: ${report.config.scenarios.join(', ')} · repeats: ${report.config.repeats}`,
    `- swarm: real local dsh-swarm (${report.config.swarmRoot}) with ${report.config.members}`,
    `- pressure: ${report.config.pressure}`,
    `- stall thresholds: ${Object.entries(report.config.stallMs).map(([scenario, ms]) => `${scenario}=${ms}ms`).join(', ')} (I-1/I-3 disable the stall case so the tested signal owns the wake)`,
    `- watch cost: ${report.spendCny === 0 ? '0' : `¥${report.spendCny}`} (cap ¥${report.config.maxCostCny})`,
    '',
    '| group | scenario | # | detection | case | actions | final | ratio | wake tokens | pass | note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map(row => `| ${row.group} | ${row.scenario} | ${row.repeat} | ${formatMs(row.detection?.latencyMs)} | ${row.detection?.code ?? '-'} | ${row.actions.map(action => action.kind).join('|') || '-'} | ${row.final?.status ?? '-'} | ${row.final?.ratio === undefined ? '-' : row.final.ratio.toFixed(3)} | ${row.wake === null ? '-' : row.wake.tokens} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.note} |`),
    '',
    '> Group A runs without overwatch. Group B uses the in-process deterministic guard. Group C runs the real headless host with the real `deepseek-account/deepseek-flash` watch officer; its autopilot soft actions are disabled so the comparison measures the watch judgment, while the 1.00 hard abort stays deterministic.',
  ]
  return lines.join('\n')
}

/** @param {{ group: string, scenario: string, repeat: number, error: unknown }} input */
function failedRow(input) {
  return {
    ...baseRow(input),
    pass: false,
    note: `error: ${messageOf(input.error)}`,
    final: { status: 'failed', spent: 0, limit: RUN_BUDGET, ratio: 0 },
    detection: null,
    actions: [],
    wake: null,
    cases: [],
    watch: null,
    wallMs: 0,
  }
}

/** @param {{ group: string, scenario: string, repeat: number }} input */
function baseRow(input) {
  return {
    group: input.group,
    scenario: input.scenario,
    repeat: input.repeat,
    startedAt: new Date().toISOString(),
    runId: null,
    childId: null,
    injectedAt: null,
    referenceAt: null,
    stallMs: null,
    armed: null,
    detection: null,
    actions: [],
    wake: null,
    cases: [],
    watch: null,
    final: null,
    wallMs: null,
    pass: false,
    note: '',
  }
}

class HangingRunner {
  constructor() {
    this.starts = 0
  }

  /** @param {{ cwd: string, prompt: string }} input */
  async start(input) {
    this.starts += 1
    const id = /^id: (\S+)$/m.exec(input.prompt)?.[1] ?? `task_${this.starts}`
    return {
      childId: `abc-child-${this.starts}-${id.replace(/[^A-Za-z0-9_-]/g, '').slice(-8)}`,
      result: new Promise(() => {}),
      dispose: () => undefined,
    }
  }
}

async function makeRepo(dir) {
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  mkdirSync(path.join(dir, 'test'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"name":"abc-repo","private":true,"type":"module"}\n', 'utf8')
  writeFileSync(path.join(dir, 'test', 'abc.test.js'), "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('abc repo healthy', () => assert.equal(1, 1))\n", 'utf8')
  git(['init'], dir)
  git(['checkout', '-b', 'main'], dir)
  git(['config', 'user.email', 'abc@dsh-overwatch.local'], dir)
  git(['config', 'user.name', 'ABC harness'], dir)
  git(['add', '-A'], dir)
  git(['commit', '-m', 'abc base'], dir)
  return dir
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return result
}

/** Remove leftovers from earlier processes; the current process releases its own on exit. */
function sweepTempDirs() {
  let names = []
  try {
    names = readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith('overwatch-abc-')) continue
    try {
      rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch {
      // still held by another process; skip
    }
  }
}

/** @param {string} file */
function readJsonl(file) {
  try {
    const body = readFileSync(file, 'utf8')
    const events = []
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // The log is appended concurrently; skip a half-written tail line.
      }
    }
    return events
  } catch {
    return []
  }
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** @param {import('node:child_process').ChildProcess} child @param {number} timeoutMs */
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)))
  const timer = setTimeout(() => resolve(false), timeoutMs)
  const ok = await exited
  clearTimeout(timer)
  if (!ok) stopChild(child)
}

/** @param {import('node:child_process').ChildProcess} child */
function stopChild(child) {
  if (child === null || child.exitCode !== null) return
  const pid = child.pid
  if (process.platform === 'win32' && pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

function ensureDesktop() {
  const credentialFile = path.join(process.env.OVERWATCH_ABC_REAL_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(credentialFile)) fatal(`C group needs ${credentialFile}`)
  if (!existsSync(executable) || !existsSync(path.join(desktopRoot, 'resources', 'app.asar'))) {
    fatal(`cannot find the Desktop installation under ${desktopRoot}`)
  }
}

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
// Per-run profile names avoid pnpm's store project symlink colliding with a
// profile directory that a previous run already removed on Windows.
let profileName = 'abc'

/** @param {string[]} args @param {{ timeout?: number }} [options] */
function mustRun(args, options = {}) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: process.cwd(),
    env: { ...cleanEnv(), DSH_HOME: currentHome(), ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} exited ${String(result.status)}:\n${`${result.stdout}\n${result.stderr}`.slice(-3_000)}`)
  }
  return result
}

/** The profile is created inside the current run's temp home. */
let activeHome = ''
function currentHome() {
  return activeHome
}

/** @param {string} home */
function setHome(home) {
  activeHome = home
}

/** @param {number} tokens */
function estimateCny(tokens) {
  return (tokens / 1_000_000) * priceOutputCnyPerM
}

/** @param {number | null | undefined} ms */
function formatMs(ms) {
  if (ms === null || ms === undefined) return '-'
  return `${Math.round(ms)}ms`
}

/** @param {string} name @param {string} fallback */
function valueArg(name, fallback) {
  const aliases = [name, name === 'groups' ? 'group' : name === 'scenarios' ? 'scenario' : name === 'repeats' ? 'repeat' : name]
  for (const alias of aliases) {
    const index = process.argv.indexOf(`--${alias}`)
    if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  }
  return fallback
}

/** @param {string} name @param {number} fallback */
function intArg(name, fallback) {
  const raw = valueArg(name, String(fallback))
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : fallback
}

/** @param {string} name @param {string} fallback */
function listArg(name, fallback) {
  return valueArg(name, fallback).split(',').map(item => item.trim()).filter(item => item !== '')
}

/** @param {string} file */
async function importPath(file) {
  return import(pathToFileURL(file).href)
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !key.startsWith('OVERWATCH_ABC_')))
}

/** @param {number} ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} message @returns {never} */
function fatal(message) {
  console.error(`abc: ${message}`)
  process.exit(2)
}

await main()
