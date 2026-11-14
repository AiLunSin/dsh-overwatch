/**
 * M4 real-model watch probe.
 *
 * A headless DSH profile with:
 * - a scripted fake provider for the root agent (arm → wait → disarm),
 * - the real Desktop `deepseek-account` provider for the watch child via
 *   `supervisor.agentOptions`,
 * - the in-process fake swarm from e2e/m2.
 *
 * It measures one real watch wake end-to-end: real tool calls, decision,
 * executor action, token usage and the hash chain. The root never calls a real
 * model, so the cost is one watch wake. Budget guard: 80k watch tokens / 200s.
 *
 * Usage: node e2e/m4/run.mjs [--keep] [--reasoning off|low|high|max]
 * Credentials: the current `$DSH_HOME/.credentials.yaml` is copied into a
 * temporary DSH_HOME; it is never printed or published.
 * @module dsh-overwatch/e2e/m4/run
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChain } from '../../src/store.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')
const reasoningArg = process.argv.indexOf('--reasoning')
const reasoningEffort = reasoningArg >= 0 ? process.argv[reasoningArg + 1] : 'off'
if (!['off', 'low', 'high', 'max'].includes(reasoningEffort)) {
  console.error(`m4: invalid --reasoning ${String(reasoningEffort)}`)
  process.exit(2)
}

const RUN_ID = 'swarm_m4'
const PROFILE = 'm4real'
const TOKEN_BUDGET = 80_000
const WALL_BUDGET_MS = 200_000

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
if (!existsSync(executable) || !existsSync(path.join(desktopRoot, 'resources', 'app.asar'))) {
  console.error(`m4: cannot find the Desktop installation under ${desktopRoot}`)
  process.exit(1)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'overwatch-m4-real-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
const resultsDir = path.join(temp, 'results')
const publishedDir = path.join(repoRoot, 'e2e', 'm4', 'results')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(resultsDir, { recursive: true })

const realHome = process.env.OVERWATCH_M4_REAL_HOME ?? path.join(os.homedir(), '.dsh')
const credentialFile = path.join(realHome, '.credentials.yaml')
if (!existsSync(credentialFile)) {
  console.error(`m4: no credentials file at ${credentialFile}; the real provider cannot authenticate`)
  process.exit(2)
}
copyFileSync(credentialFile, path.join(home, '.credentials.yaml'))

const fishDir = path.join(temp, 'fish-data')
mkdirSync(path.join(fishDir, 'checkpoints', 'fish-a'), { recursive: true })
mkdirSync(path.join(fishDir, 'audit'), { recursive: true })
writeFileSync(path.join(fishDir, 'checkpoints', 'fish-a', 'index.jsonl'), `${JSON.stringify({
  schemaVersion: 1, id: 'ck_m4', createdAt: new Date().toISOString(), trigger: 'manual', files: 1, storedBytes: 10, pinned: false,
})}\n`, 'utf8')

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !key.startsWith('OVERWATCH_M4_')),
)

/** @param {string[]} args @param {{ timeout?: number, env?: Record<string,string> }} [options] */
function runCli(args, options = {}) {
  return spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: work,
    env: { ...cleanEnv, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
}

/** @param {string[]} args @param {{ timeout?: number }} [options] */
function mustRun(args, options = {}) {
  const result = runCli(args, options)
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} exited ${result.status}:\n${`${result.stdout}\n${result.stderr}`.slice(-3_000)}`)
  }
  return result
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

/** @param {number} port */
function createProfile(port) {
  mustRun(['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  mustRun(['plugin', '--profile', PROFILE, 'add', repoRoot, path.join(repoRoot, 'e2e', 'm2', 'harness'), path.join(repoRoot, 'e2e', 'm4', 'fake-llm')], { timeout: 300_000 })
  const profileDir = path.join(home, 'profiles', PROFILE)
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    'dsh-overwatch',
    'dsh-overwatch-m2-harness',
    'dsh-fake-llm-m4',
  ]
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# M4 real-watch probe. Test values only; the real account credential is',
    '# copied into the throwaway DSH_HOME and never printed.',
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
    '    mode: guard',
    '    http:',
    '      token: m4-token',
    '    ports:',
    `      origin: http://127.0.0.1:${port}`,
    '      swarmToken: m4-swarm-token',
    '    fish:',
    `      dataDir: '${fishDir.replaceAll('\\', '/')}'`,
    '    sampling:',
    '      swarmEventMs: 500',
    '      swarmSnapshotMs: 500',
    '      pressureMs: 500',
    '      fishMs: 500',
    '      staleMs: 5000',
    '      requestTimeoutMs: 2000',
    '      maxInflight: 2',
    '    supervisor:',
    '      maxWakes: 1',
    '      maxWakesPerHour: 1',
    '      wakeTimeoutMs: 120000',
    '      maxEvidenceCalls: 2',
    '      maxTokensPerWake: 20000',
    '      agentOptions:',
    '        provider: deepseek-account',
    '        model: deepseek-flash',
    `        reasoningEffort: ${reasoningEffort}`,
    '        maxTokens: 2048',
    '    policy:',
    '      twoSignalRule: true',
    '      autopilot:',
    '        throttle: false',
    '        pause: false',
    '        pauseOnHardLimit: true',
    '        abortOnHardLimit: true',
    '- id: dsh-overwatch-m2-harness',
    '  config:',
    `    port: ${port}`,
    '    token: m4-swarm-token',
    '    runId: swarm_m4',
  ].join('\n') + '\n', 'utf8')
  return profileDir
}

/** @param {string} file */
function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** @param {string} file */
function readChain(file) {
  try {
    const parsed = parseChain(readFileSync(file, 'utf8'), RUN_ID)
    return {
      ok: parsed.error === null,
      count: parsed.events.length,
      error: parsed.error === null ? null : `${parsed.error.code} at line ${parsed.error.line}`,
      events: parsed.events,
    }
  } catch (error) {
    return { ok: false, count: 0, error: error instanceof Error ? error.message : String(error), events: [] }
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {number} ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {any[]} events @param {string} type */
function countType(events, type) {
  return events.filter(event => event.type === type).length
}

async function main() {
  const startedAt = new Date()
  const startedMs = Date.now()
  const summary = {
    schemaVersion: 1,
    stage: 'm4-real-watch',
    dshVersion: 'unknown',
    reasoningEffort,
    budget: { tokens: TOKEN_BUDGET, wallMs: WALL_BUDGET_MS },
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    error: null,
    checks: {},
    gate: null,
    usage: null,
  }
  let report = null
  let host = null
  let logPath = path.join(resultsDir, 'run.log')
  try {
    summary.dshVersion = (runCli(['--version']).stdout || '').trim() || 'unknown'
    console.log(`m4: DSH ${summary.dshVersion}; reasoning=${reasoningEffort}`)
    const port = await freePort()
    const profileDir = createProfile(port)
    const watchFile = path.join(home, 'overwatch', 'runs', RUN_ID, 'watch.jsonl')
    const callsFile = path.join(resultsDir, 'calls.json')
    const llmLog = path.join(resultsDir, 'llm.jsonl')
    const stdout = []
    const stderr = []
    host = spawn(executable, ['--expose-internals', cli, '--profile', PROFILE, 'M4-ROOT: arm supervised, wait for the watch officer, then disarm.'], {
      cwd: work,
      env: {
        ...cleanEnv,
        DSH_HOME: home,
        ELECTRON_RUN_AS_NODE: '1',
        OVERWATCH_M4_WATCH: watchFile,
        OVERWATCH_M4_LLM_LOG: llmLog,
        OVERWATCH_M2_CALLS: callsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    host.stdout.on('data', chunk => stdout.push(String(chunk)))
    host.stderr.on('data', chunk => stderr.push(String(chunk)))
    let exitInfo = null
    host.once('exit', (code, signal) => { exitInfo = { code, signal } })

    const deadline = Date.now() + WALL_BUDGET_MS
    let chain = { ok: false, count: 0, events: [], error: 'not started' }
    let usage = null
    while (Date.now() < deadline) {
      chain = readChain(watchFile)
      usage = chain.events.filter(event => event.type === 'watch/usage').at(-1)?.payload ?? null
      if (usage !== null && Number(usage.spent) > TOKEN_BUDGET) {
        summary.error = `watch token budget exceeded: ${usage.spent}`
        break
      }
      if (chain.events.some(event => event.type === 'watch/disarmed')) break
      if (exitInfo !== null) break
      await delay(500)
    }
    await stopChild(host)
    writeFileSync(logPath, `--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}\n`, 'utf8')
    if (summary.error === null && !chain.events.some(event => event.type === 'watch/disarmed')) {
      summary.error = exitInfo === null ? 'walk wall budget reached before disarm' : `host exited (${String(exitInfo.code)}) before disarm`
    }
    report = buildReport({ chain, usage, calls: readJsonl(callsFile), llm: readJsonl(llmLog), reasoningEffort, dshVersion: summary.dshVersion, exitInfo })
    summary.checks = report.checks
    summary.gate = { ok: Object.values(report.checks).every(check => check.status === 'pass'), failed: Object.entries(report.checks).filter(([, check]) => check.status !== 'pass').map(([id]) => id), total: Object.keys(report.checks).length }
    summary.usage = usage
    console.log(`m4: checks: ${Object.entries(report.checks).map(([id, check]) => `${id}=${check.status}`).join(' ')}`)
    if (summary.gate.ok) console.log('m4: gate PASS')
    else console.error(`m4: gate FAIL (${summary.gate.failed.join(', ')})`)
  } catch (error) {
    summary.error = `${error instanceof Error ? error.name : 'Error'}: ${messageOf(error)}`
    console.error(`m4: FAIL: ${summary.error}`)
  } finally {
    summary.finishedAt = new Date().toISOString()
    summary.durationMs = Date.now() - startedMs
    const exitCode = summary.error === null && summary.gate?.ok === true ? 0 : 1
    summary.exitCode = exitCode
    rmSync(publishedDir, { recursive: true, force: true })
    mkdirSync(publishedDir, { recursive: true })
    try {
      if (report !== null) writeFileSync(path.join(publishedDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      for (const name of ['calls.json', 'llm.jsonl', 'run.log']) {
        if (existsSync(path.join(resultsDir, name))) copyFileSync(path.join(resultsDir, name), path.join(publishedDir, name))
      }
      const watchFile = path.join(home, 'overwatch', 'runs', RUN_ID, 'watch.jsonl')
      if (existsSync(watchFile)) copyFileSync(watchFile, path.join(publishedDir, 'watch.jsonl'))
      const profileDir = path.join(home, 'profiles', PROFILE)
      if (existsSync(path.join(profileDir, 'cordis.patch.yml'))) copyFileSync(path.join(profileDir, 'cordis.patch.yml'), path.join(publishedDir, 'profile-cordis.patch.yml'))
    } catch (error) {
      summary.publishError = messageOf(error)
    }
    writeFileSync(path.join(publishedDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    if (!keep) {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch (error) {
        console.error(`m4: could not remove temp: ${messageOf(error)}`)
      }
    } else {
      console.log(`m4: kept ${temp}`)
    }
    console.log(`m4: evidence in ${publishedDir}`)
    process.exitCode = exitCode
  }
}

/** @param {import('node:child_process').ChildProcess} child */
async function stopChild(child) {
  if (child === null || child.exitCode !== null) return
  const pid = child.pid
  if (process.platform === 'win32' && pid !== undefined) {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    if (killed.status !== 0 && killed.status !== 128) console.error(`m4: taskkill ${String(killed.status)} ${String(killed.stderr).trim()}`)
    await delay(500)
  }
}

/**
 * @param {{ chain: any, usage: any, calls: any[], llm: any[], reasoningEffort: string, dshVersion: string, exitInfo: any }} input
 */
function buildReport(input) {
  const events = input.chain.events
  const armed = events.find(event => event.type === 'watch/armed') ?? null
  const decision = events.find(event => event.type === 'watch/decision') ?? null
  const timedOut = events.find(event => event.type === 'watch/wake/timeout') ?? null
  const intended = events.find(event => event.type === 'watch/action/intended') ?? null
  const executed = events.find(event => event.type === 'watch/action/executed') ?? null
  const verified = events.find(event => event.type === 'watch/action/verified') ?? null
  const usage = input.usage
  const spent = Number(usage?.spent ?? 0)
  const options = armed?.payload?.agentOptions ?? null
  const routeOk = options !== null && options.provider === 'deepseek-account' && options.model === 'deepseek-flash'
  const check = (ok, evidence) => ({ status: ok ? 'pass' : 'fail', evidence })
  return {
    schemaVersion: 1,
    stage: 'm4-real-watch',
    dshVersion: input.dshVersion,
    reasoningEffort: input.reasoningEffort,
    checks: {
      'chain-ok': check(input.chain.ok && input.chain.count > 0, { ok: input.chain.ok, count: input.chain.count, error: input.chain.error }),
      'armed-supervised': check(armed?.payload?.mode === 'supervised', armed?.payload ?? null),
      'real-route': check(routeOk, options),
      'case-opened': check(countType(events, 'watch/case/opened') >= 1, { opened: countType(events, 'watch/case/opened') }),
      'wake-recorded': check(countType(events, 'watch/wake') === 1, { wakes: countType(events, 'watch/wake') }),
      'decision-produced': check(decision !== null, decision?.payload ?? { timedOut: timedOut?.payload ?? null }),
      'action-chain': check(intended !== null && executed !== null && verified !== null, {
        intended: intended?.payload ?? null,
        executed: executed?.payload ?? null,
        verified: verified?.payload ?? null,
      }),
      'usage-capped': check(usage !== null && spent > 0 && spent <= TOKEN_BUDGET, { spent, budget: TOKEN_BUDGET }),
      'disarmed': check(events.some(event => event.type === 'watch/disarmed'), { disarmed: countType(events, 'watch/disarmed') }),
    },
    decision: decision?.payload ?? null,
    timedOut: timedOut?.payload ?? null,
    usage,
    calls: input.calls,
    llm: input.llm,
    events: events.map(event => ({ seq: event.seq, type: event.type, at: event.at, payload: event.payload })),
    errors: input.exitInfo?.code === 0 || input.exitInfo === null ? [] : [`host exit ${String(input.exitInfo.code)}`],
  }
}

await main()
