/**
 * Real dsh-swarm I-5 / I-6 / I-7 integration.
 *
 * Unlike `test/scenarios.test.js` (deterministic fake events), this runner
 * exercises the real swarm service, the real task market, real review state,
 * real git worktrees, real gate commands, and real merge conflicts. Overwatch
 * is armed in guard mode and reads the real `/swarm/api` surface, exactly as it
 * does in production; its autopilot is disabled so the run measures detection,
 * not interventions.
 *
 * No model calls: the worker edits are scripted into the real worktree, so the
 * whole probe is free and deterministic while the coordination machinery is
 * genuinely exercised.
 *
 * Scenarios:
 * - I-5 review deadlock: a real patch enters `reviewing` and nobody votes.
 * - I-6 gate ping-pong: three real gate runs fail on the same task.
 * - I-7 conflict storm: four parallel tasks touch one file; one merges and
 *   three real git merges conflict.
 *
 * Usage: node e2e/m4/swarm-signals/run.mjs [--keep] [--scenario I-5]
 * @module dsh-overwatch/e2e/m4/swarm-signals
 */

import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseChain } from '../../../src/store.js'
import { resolveConfig as resolveOverwatchConfig } from '../../../src/config.js'
import { OverwatchService } from '../../../src/service.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const swarmRoot = process.env.DSH_SWARM_ROOT ?? path.resolve(repoRoot, '..', 'em', 'dsh-swarm')
const resultsDir = path.join(repoRoot, 'e2e', 'm4', 'swarm-signals', 'results')
const keep = process.argv.includes('--keep')
const only = valueArg('scenario', '')
const SCENARIOS = only === '' ? ['I-5', 'I-6', 'I-7'] : [only]

const SWARM_TOKEN = 'swarm-signals-token'
const HTTP_TOKEN = 'swarm-signals-http'
const PASS_GATE = 'node -e "process.exit(0)"'
const FAIL_GATE = 'node -e "process.exit(1)"'

const swarmConfigModule = await importPath(path.join(swarmRoot, 'src', 'config.js'))
const swarmServiceModule = await importPath(path.join(swarmRoot, 'src', 'service.js'))
const swarmHttpModule = await importPath(path.join(swarmRoot, 'src', 'http.js'))
const resolveSwarmConfig = swarmConfigModule.resolveConfig
const { SwarmService } = swarmServiceModule
const { createNodeHandler } = swarmHttpModule

const startedAt = new Date()
const rows = []
let tempRoot = ''

await main()

async function main() {
  if (only !== '' && !SCENARIOS.includes(only)) fatal(`unknown scenario ${only}`)
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'overwatch-swarm-signals-'))
  rmSync(resultsDir, { recursive: true, force: true })
  mkdirSync(resultsDir, { recursive: true })
  console.log(`swarm-signals: scenarios=${SCENARIOS.join(',')} swarm=${swarmRoot}`)
  for (const scenario of SCENARIOS) {
    console.log(`swarm-signals: run ${scenario}`)
    const temp = path.join(tempRoot, scenario)
    mkdirSync(temp, { recursive: true })
    let row
    try {
      if (scenario === 'I-5') row = await scenarioReviewDeadlock(temp)
      else if (scenario === 'I-6') row = await scenarioGatePingpong(temp)
      else row = await scenarioConflictStorm(temp)
    } catch (error) {
      row = { scenario, pass: false, error: messageOf(error), at: new Date().toISOString() }
    }
    rows.push(row)
    console.log(`swarm-signals: ${row.pass ? 'PASS' : 'FAIL'} ${scenario} ${row.note ?? row.error ?? ''}`)
  }
  const report = {
    schemaVersion: 1,
    stage: 'm4-swarm-signals',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    mode: 'real dsh-swarm service + real git worktrees/reviews/merges; scripted worker edits (no model calls)',
    swarmRoot,
    node: process.version,
    platform: process.platform,
    pass: rows.every(row => row.pass === true),
    scenarios: rows,
  }
  writeFileSync(path.join(resultsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(resultsDir, 'summary.md'), markdown(report), 'utf8')
  console.log('')
  console.log(markdown(report))
  if (!keep) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  else console.log(`swarm-signals: kept ${tempRoot}`)
  process.exit(report.pass ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/* I-5: real review deadlock                                          */
/* ------------------------------------------------------------------ */

async function scenarioReviewDeadlock(temp) {
  const repo = await makeRepo(path.join(temp, 'repo'))
  const baseDir = path.join(temp, 'swarm-base')
  const dataDir = path.join(temp, 'overwatch')
  const { service } = await openSwarm({ baseDir, repo, members: 2, gate: PASS_GATE })
  const runId = await createRun(service, repo, 2, 'I-5 review deadlock')
  const port = await freePort()
  const server = await startServer(service, port)
  const overwatch = await startOverwatch({ dataDir, port, runId })
  try {
    const task = await createTaskFlow(service, runId, {
      title: 'change the review target',
      file: 'src/review.js',
      member: workerOf(await service.status(runId, true)),
    })
    await commitFile(task.worktree, 'src/review.js', "export const reviewed = true\n", 'feat: review target')
    const submitted = await submitPatch(service, runId, task)
    if (submitted.review.reviewers.length === 0) throw new Error('real review has no reviewer')
    const openedAt = Date.now()
    const opened = await waitForCase(dataDir, runId, 'review_deadlock', 20_000)
    const status = await service.status(runId, true)
    const taskState = taskStateOf(status, task.taskId)
    const events = readSwarmEvents(baseDir, runId)
    const watch = readWatch(dataDir, runId)
    const row = {
      scenario: 'I-5',
      pass: opened !== null
        && taskState === 'reviewing'
        && events.some(event => event.type === 'swarm/review/opened')
        && !events.some(event => event.type === 'swarm/vote/cast')
        && watch.chain.ok,
      note: `task=${taskState} reviewers=${submitted.review.reviewers.length} votes=0 case=${opened?.payload?.code ?? 'none'}`,
      detectionMs: opened === null ? null : Date.parse(opened.at) - openedAt,
      case: opened === null ? null : caseView(dataDir, runId, opened.payload?.caseId),
      watchChain: watch.chain,
      swarm: summarizeSwarm(events),
      taskState,
      patchId: submitted.patchId,
      at: new Date().toISOString(),
    }
    archive(dataDir, baseDir, runId, 'I-5')
    return row
  } finally {
    overwatch.close()
    await server.close()
    await service.close()
  }
}

/* ------------------------------------------------------------------ */
/* I-6: real gate ping-pong                                           */
/* ------------------------------------------------------------------ */

async function scenarioGatePingpong(temp) {
  const repo = await makeRepo(path.join(temp, 'repo'))
  const baseDir = path.join(temp, 'swarm-base')
  const dataDir = path.join(temp, 'overwatch')
  const { service } = await openSwarm({ baseDir, repo, members: 2, gate: FAIL_GATE })
  const runId = await createRun(service, repo, 2, 'I-6 gate ping-pong')
  const port = await freePort()
  const server = await startServer(service, port)
  const overwatch = await startOverwatch({ dataDir, port, runId })
  try {
    const worker = workerOf(await service.status(runId, true))
    const task = await createTaskFlow(service, runId, {
      title: 'keep failing the real gate',
      file: 'src/gate.js',
      member: worker,
    })
    /** @type {any[]} */
    const cycles = []
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await commitFile(task.worktree, 'src/gate.js', `export const attempt = ${cycle}\n`, `attempt ${cycle}`)
      const submitted = await submitPatch(service, runId, task)
      for (const reviewerId of submitted.review.reviewers) {
        await service.reviewPatch(runId, submitted.patchId, {
          memberId: reviewerId,
          verdict: 'approve',
          evidence: [`real gate command: ${FAIL_GATE}`, 'src/gate.js: attempt'],
        })
      }
      const merge = await mergeExpecting(service, runId, submitted.patchId)
      cycles.push({ cycle, patchId: submitted.patchId, mergeCode: merge.code, mergeOk: merge.ok })
    }
    const openedAt = Date.now()
    const opened = await waitForCase(dataDir, runId, 'gate_pingpong', 20_000)
    const status = await service.status(runId, true)
    const events = readSwarmEvents(baseDir, runId)
    const gateFailures = events.filter(event => event.type === 'swarm/task/gate' && event.payload?.gate?.passed === false).length
    const watch = readWatch(dataDir, runId)
    const state = taskStateOf(status, task.taskId)
    const row = {
      scenario: 'I-6',
      pass: opened !== null
        && gateFailures >= 3
        && state === 'working'
        && cycles.every(item => item.mergeOk === false && item.mergeCode === 'GATE_FAILED')
        && watch.chain.ok,
      note: `gateFailures=${gateFailures} task=${state} cycles=${cycles.map(item => item.mergeCode).join(',')} case=${opened?.payload?.code ?? 'none'}`,
      detectionMs: opened === null ? null : Date.parse(opened.at) - openedAt,
      case: opened === null ? null : caseView(dataDir, runId, opened.payload?.caseId),
      watchChain: watch.chain,
      swarm: summarizeSwarm(events),
      taskState: state,
      cycles,
      at: new Date().toISOString(),
    }
    archive(dataDir, baseDir, runId, 'I-6')
    return row
  } finally {
    overwatch.close()
    await server.close()
    await service.close()
  }
}

/* ------------------------------------------------------------------ */
/* I-7: real merge conflict storm                                     */
/* ------------------------------------------------------------------ */

async function scenarioConflictStorm(temp) {
  const repo = await makeRepo(path.join(temp, 'repo'))
  const baseDir = path.join(temp, 'swarm-base')
  const dataDir = path.join(temp, 'overwatch')
  const { service } = await openSwarm({ baseDir, repo, members: 5, gate: PASS_GATE })
  const runId = await createRun(service, repo, 5, 'I-7 conflict storm')
  const port = await freePort()
  const server = await startServer(service, port)
  const overwatch = await startOverwatch({ dataDir, port, runId })
  try {
    const status = await service.status(runId, true)
    const workers = status.members.filter(member => member.role === 'worker')
    if (workers.length < 4) throw new Error(`need 4 workers, got ${workers.length}`)
    const tasks = []
    for (let index = 0; index < 4; index += 1) {
      tasks.push(await createTaskFlow(service, runId, {
        title: `edit shared.js part ${index + 1}`,
        file: 'src/shared.js',
        member: workers[index],
      }))
    }
    // All four branches were cut from the same base commit before any merge.
    const patches = []
    for (let index = 0; index < tasks.length; index += 1) {
      await commitFile(tasks[index].worktree, 'src/shared.js', `export const shared = 'task-${index + 1}'\n`, `task ${index + 1}`)
      const submitted = await submitPatch(service, runId, tasks[index])
      for (const reviewerId of submitted.review.reviewers) {
        await service.reviewPatch(runId, submitted.patchId, {
          memberId: reviewerId,
          verdict: 'approve',
          evidence: [`real gate command: ${PASS_GATE}`, `src/shared.js: task-${index + 1}`],
        })
      }
      patches.push(submitted.patchId)
    }
    const first = await service.mergePatch(runId, patches[0], {})
    const conflicts = []
    for (let index = 1; index < patches.length; index += 1) {
      const merge = await mergeExpecting(service, runId, patches[index])
      conflicts.push({ patchId: patches[index], ok: merge.ok, code: merge.code, files: merge.details?.files ?? [] })
    }
    const openedAt = Date.now()
    const opened = await waitForCase(dataDir, runId, 'conflict_storm', 20_000)
    const finalStatus = await service.status(runId, true)
    const events = readSwarmEvents(baseDir, runId)
    const conflictEvents = events.filter(event => event.type === 'swarm/merge/conflict')
    const mergedEvents = events.filter(event => event.type === 'swarm/task/merged')
    const watch = readWatch(dataDir, runId)
    const row = {
      scenario: 'I-7',
      pass: opened !== null
        && conflictEvents.length >= 3
        && mergedEvents.length === 1
        && conflicts.every(item => item.ok === false && item.code === 'MERGE_CONFLICT')
        && watch.chain.ok,
      note: `conflicts=${conflictEvents.length} merged=${mergedEvents.length} firstMerge=${first.mergeCommit.slice(0, 8)} case=${opened?.payload?.code ?? 'none'}`,
      detectionMs: opened === null ? null : Date.parse(opened.at) - openedAt,
      case: opened === null ? null : caseView(dataDir, runId, opened.payload?.caseId),
      watchChain: watch.chain,
      swarm: summarizeSwarm(events),
      tasks: tasks.map((task, index) => ({ taskId: task.taskId, state: taskStateOf(finalStatus, task.taskId), patchId: patches[index] })),
      conflicts,
      firstMergeCommit: first.mergeCommit,
      at: new Date().toISOString(),
    }
    archive(dataDir, baseDir, runId, 'I-7')
    return row
  } finally {
    overwatch.close()
    await server.close()
    await service.close()
  }
}

/* ------------------------------------------------------------------ */
/* Real swarm helpers                                                 */
/* ------------------------------------------------------------------ */

/** @param {{ baseDir: string, repo: string, members: number, gate: string }} input */
async function openSwarm(input) {
  const config = resolveSwarmConfig({
    members: input.members,
    budget: { tokens: 1_000_000, usd: 0, wallMs: 0, hardStop: false },
    taskBudget: { tokens: 100_000 },
    memberBudget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: false, minFreeMb: 0 },
    workspace: { enabled: true, root: '', diskThresholdMb: 0, keep: false, maxConcurrent: 10 },
    gate: { commands: [input.gate], autoDetect: false, timeoutMs: 30_000 },
    dispatch: { autoCommit: true, timeoutMs: 600_000, auto: false },
    review: { reviewersPerPatch: 1, quorum: 0.5, requireEvidence: true },
    market: { wipPerMember: 2 },
    convergence: { stallMs: 3_600_000 },
    http: { enabled: true, token: SWARM_TOKEN },
  })
  const service = new SwarmService({ config, baseDir: input.baseDir })
  await service.open()
  return { service }
}

async function createRun(service, repo, members, goal) {
  const run = await service.createRun({
    goal,
    repo,
    mode: 'swarm',
    members,
    budget: { tokens: 1_000_000 },
  }, { agent: { id: 'swarm-signals-parent' } })
  return run.swarmId
}

/** @param {any} status */
function workerOf(status) {
  const worker = status.members.find(member => member.role === 'worker')
  if (worker === undefined) throw new Error('swarm has no worker member')
  return worker
}

/**
 * Create, advertise, bid, award and start one real task.
 * @param {any} service
 * @param {string} runId
 * @param {{ title: string, file: string, member: any }} input
 */
async function createTaskFlow(service, runId, input) {
  const { task } = await service.createTask(runId, {
    title: input.title,
    acceptance: ['the real gate passes', 'src/ has the requested file'],
    files: [input.file],
    tags: ['integration'],
    priority: 80,
  })
  await service.advertiseTask(runId, task.id)
  await service.bid(runId, task.id, {
    memberId: input.member.id,
    estimate: { tokens: 2_000, minutes: 2 },
    reason: 'real swarm signal probe',
  })
  const awarded = await service.awardTask(runId, task.id, { memberId: input.member.id })
  if (!awarded.worktree?.path) throw new Error(`task ${task.id} has no worktree (workspace degraded)`)
  await service.startTask(runId, task.id, { memberId: input.member.id, fence: awarded.lease.fence })
  return {
    taskId: task.id,
    memberId: input.member.id,
    fence: awarded.lease.fence,
    worktree: awarded.worktree.path,
    branch: awarded.worktree.branch,
  }
}

/** @param {any} task */
async function submitPatch(service, runId, task) {
  return service.submitPatch(runId, task.taskId, {
    memberId: task.memberId,
    fence: task.fence,
    tests: [{ name: 'real gate', passed: true, output: 'gate command collected' }],
    notes: 'swarm-signals integration probe',
  })
}

/** @param {any} service @param {string} runId @param {string} patchId */
async function mergeExpecting(service, runId, patchId) {
  try {
    const merged = await service.mergePatch(runId, patchId, {})
    return { ok: true, mergeCommit: merged.mergeCommit }
  } catch (error) {
    return { ok: false, code: String(error?.code ?? 'UNKNOWN'), message: messageOf(error), details: error?.details ?? {} }
  }
}

/** @param {string} cwd @param {string} file @param {string} content @param {string} message */
async function commitFile(cwd, file, content, message) {
  const target = path.join(cwd, ...file.split('/'))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  await git(['add', '-A'], cwd)
  await git(['commit', '-m', `probe: ${message}`], cwd)
}

/** @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  return stdout.trim()
}

/** @param {string} dir */
async function makeRepo(dir) {
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  mkdirSync(path.join(dir, 'test'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"name":"swarm-signals-repo","private":true,"type":"module"}\n', 'utf8')
  writeFileSync(path.join(dir, 'test', 'smoke.test.js'), "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('repo is healthy', () => assert.equal(1, 1))\n", 'utf8')
  await git(['init', '-b', 'main'], dir)
  await git(['config', 'user.email', 'swarm-signals@dsh.local'], dir)
  await git(['config', 'user.name', 'swarm-signals'], dir)
  await git(['add', '-A'], dir)
  await git(['commit', '-m', 'probe base'], dir)
  return dir
}

/* ------------------------------------------------------------------ */
/* Overwatch helpers                                                  */
/* ------------------------------------------------------------------ */

async function startOverwatch({ dataDir, port, runId }) {
  const config = resolveOverwatchConfig({
    enabled: true,
    mode: 'guard',
    http: { enabled: false, token: HTTP_TOKEN },
    ports: { origin: `http://127.0.0.1:${port}`, swarmToken: SWARM_TOKEN },
    storage: { dataDir },
    sampling: { swarmEventMs: 200, swarmSnapshotMs: 200, pressureMs: 1000, fishMs: 60_000, staleMs: 5000, requestTimeoutMs: 1000, maxInflight: 2 },
    thresholds: { reviewDeadlockMs: 1000, gateFailures: 3, conflictStorm: 3, stallMs: 600_000 },
    policy: {
      twoSignalRule: true,
      maxAutoInterventions: 0,
      autopilot: { throttle: false, pause: false, pauseOnHardLimit: false, abortOnHardLimit: false, budgetAdjust: false, restore: false },
    },
  })
  const service = new OverwatchService({
    ctx: { get: () => undefined },
    config,
    version: 'swarm-signals',
    logger: { warn: message => console.error(`swarm-signals[overwatch]: ${message}`) },
  })
  await service.open()
  await service.arm({ runId, mode: 'guard' })
  return service
}

/** Real swarm HTTP surface plus a quiet pressure stub. */
async function startServer(swarm, port) {
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
      writeJson(res, 200, {
        ok: true,
        data: {
          sessionId: url.searchParams.get('sessionId') ?? '',
          context: { pressure: 0.42 },
          tools: { failures: 0, repeats: 0 },
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

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/* ------------------------------------------------------------------ */
/* Evidence helpers                                                   */
/* ------------------------------------------------------------------ */

/** @param {string} dataDir @param {string} runId @param {string} code @param {number} timeoutMs */
async function waitForCase(dataDir, runId, code, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = readJsonl(path.join(dataDir, 'runs', runId, 'watch.jsonl'))
    const opened = events.find(event => event.type === 'watch/case/opened' && event.payload?.code === code)
    if (opened !== undefined) return opened
    await delay(200)
  }
  return null
}

/** @param {string} dataDir @param {string} runId */
function readWatch(dataDir, runId) {
  const file = path.join(dataDir, 'runs', runId, 'watch.jsonl')
  const events = readJsonl(file)
  let chain = { ok: false, count: events.length, error: 'watch log is missing' }
  try {
    const parsed = parseChain(readFileSync(file, 'utf8'), runId)
    chain = {
      ok: parsed.error === null,
      count: parsed.events.length,
      error: parsed.error === null ? null : `${parsed.error.code} at line ${parsed.error.line}`,
    }
  } catch (error) {
    chain = { ok: false, count: 0, error: messageOf(error) }
  }
  return { events, chain }
}

/** @param {string} dataDir @param {string} runId @param {string | undefined} caseId */
function caseView(dataDir, runId, caseId) {
  if (typeof caseId !== 'string') return null
  try {
    const record = JSON.parse(readFileSync(path.join(dataDir, 'runs', runId, 'cases', `${caseId}.json`), 'utf8'))
    return {
      id: record.id,
      code: record.code,
      severity: record.severity,
      state: record.state,
      evidence: (record.evidence ?? []).map(entry => entry.id),
      observed: (record.signals?.[0]?.observed ?? null),
    }
  } catch {
    return null
  }
}

/** @param {string} baseDir @param {string} runId */
function readSwarmEvents(baseDir, runId) {
  return readJsonl(path.join(baseDir, 'runs', runId, 'events.jsonl'))
}

/** @param {any[]} events */
function summarizeSwarm(events) {
  const count = type => events.filter(event => event.type === type).length
  return {
    total: events.length,
    lastSeq: events.at(-1)?.seq ?? 0,
    reviewOpened: count('swarm/review/opened'),
    votes: count('swarm/vote/cast'),
    gateFailures: events.filter(event => event.type === 'swarm/task/gate' && event.payload?.gate?.passed === false).length,
    conflicts: count('swarm/merge/conflict'),
    merged: count('swarm/task/merged'),
  }
}

/** @param {any} status @param {string} taskId */
function taskStateOf(status, taskId) {
  return status.tasks.find(task => task.id === taskId)?.state ?? 'missing'
}

function archive(dataDir, baseDir, runId, name) {
  const dest = path.join(resultsDir, name)
  mkdirSync(dest, { recursive: true })
  copyIf(path.join(dataDir, 'runs', runId, 'watch.jsonl'), path.join(dest, 'watch.jsonl'))
  copyIf(path.join(dataDir, 'runs', runId, 'cases'), path.join(dest, 'cases'))
  copyIf(path.join(baseDir, 'runs', runId, 'events.jsonl'), path.join(dest, 'swarm-events.jsonl'))
  copyIf(path.join(baseDir, 'runs', runId, 'snapshot.json'), path.join(dest, 'swarm-snapshot.json'))
}

/** @param {string} from @param {string} to */
function copyIf(from, to) {
  if (existsSync(from)) cpSync(from, to, { recursive: true })
}

/** @param {string} file */
function readJsonl(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A tail torn by a crash is not evidence.
    }
  }
  return events
}

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

function markdown(report) {
  const lines = [
    '# Real dsh-swarm I-5/I-6/I-7',
    '',
    `- mode: ${report.mode}`,
    `- swarm: \`${report.swarmRoot}\``,
    `- at: ${report.finishedAt}`,
    '',
    '| scenario | pass | case | detection | real events | note |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of report.scenarios) {
    const events = row.swarm === undefined
      ? '-'
      : `review=${row.swarm.reviewOpened} votes=${row.swarm.votes} gateFail=${row.swarm.gateFailures} conflicts=${row.swarm.conflicts} merged=${row.swarm.merged}`
    lines.push(`| ${row.scenario} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.case?.code ?? '-'} | ${row.detectionMs === null || row.detectionMs === undefined ? '-' : `${row.detectionMs}ms`} | ${events} | ${row.note ?? row.error ?? ''} |`)
  }
  lines.push('', 'Each scenario runs the real `SwarmService` against a real git repository: real task market, real review state, real worktrees, real gate commands and real merges. Worker edits are scripted so no model tokens are spent.', '')
  return lines.join('\n')
}

/** @param {string} url */
async function importPath(file) {
  return import(pathToFileURL(file).href)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} name @param {string} fallback */
function valueArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

/** @param {string} message @returns {never} */
function fatal(message) {
  console.error(`swarm-signals: ${message}`)
  process.exit(2)
}
