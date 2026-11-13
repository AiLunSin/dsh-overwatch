/**
 * M2 runner: a headless Desktop DSH profile with a scripted provider, a
 * tool-restricted watch officer, and an in-process fake swarm HTTP surface.
 *
 * Unlike M1 this exercises the real subagent runtime: the root calls
 * `watch_arm(mode: 'supervised')`, overwatch opens a case, starts a
 * `delivery: 'caller'` child, the child calls watch_case -> watch_evidence ->
 * watch_decide(coach), the executor calls the fake swarm, and the root disarms.
 *
 * Usage: node e2e/m2/run.mjs [--keep]
 * @module dsh-overwatch/e2e/m2/run
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChain } from '../../src/store.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')
const PROFILE = 'm2'
const WATCH_RUN = 'swarm_m2'

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

if (!existsSync(executable) || !existsSync(path.join(desktopRoot, 'resources', 'app.asar'))) {
  console.error(`m2: cannot find the Desktop installation under ${desktopRoot}`)
  process.exit(1)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'overwatch-m2-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
const resultsDir = path.join(temp, 'results')
const publishedDir = path.join(repoRoot, 'e2e', 'm2', 'results')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(resultsDir, { recursive: true })

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !key.startsWith('OVERWATCH_M2_')),
)

/** @param {string[]} args @param {{ timeout?: number }} [options] */
function runCli(args, options = {}) {
  return spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: work,
    env: {
      ...cleanEnv,
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
      OVERWATCH_M2_CALLS: path.join(resultsDir, 'calls.json'),
      OVERWATCH_M2_LLM_LOG: path.join(resultsDir, 'llm.jsonl'),
    },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
}

/** @param {string[]} args @param {{ timeout?: number }} [options] */
function mustRun(args, options) {
  const result = runCli(args, options)
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} exited ${result.status}:\n${`${result.stdout}\n${result.stderr}`.slice(-4_000)}`)
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
  mustRun(['plugin', '--profile', PROFILE, 'add', repoRoot, path.join(repoRoot, 'e2e', 'm2', 'harness'), path.join(repoRoot, 'e2e', 'm2', 'fake-llm')], { timeout: 300_000 })
  const profileDir = path.join(home, 'profiles', PROFILE)
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    'dsh-overwatch',
    'dsh-overwatch-m2-harness',
    'dsh-fake-llm-m2',
  ]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# M2 headless probe overrides. Test values only: these tokens are not secrets.',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- id: subagent',
    '  config:',
    '    maxActiveSubagents: 4',
    '- id: dsh-overwatch',
    '  config:',
    '    enabled: true',
    '    mode: guard',
    '    http:',
    '      token: m2-token',
    '    ports:',
    `      origin: http://127.0.0.1:${port}`,
    '      swarmToken: m2-swarm-token',
    '    sampling:',
    '      swarmEventMs: 500',
    '      swarmSnapshotMs: 500',
    '      pressureMs: 500',
    '      fishMs: 500',
    '      staleMs: 5000',
    '      requestTimeoutMs: 2000',
    '      maxInflight: 2',
    '    supervisor:',
    '      maxWakes: 3',
    '      maxWakesPerHour: 3',
    '      wakeTimeoutMs: 5000',
    '      maxEvidenceCalls: 2',
    '      maxTokensPerWake: 20000',
    '    policy:',
    '      twoSignalRule: true',
    '      throttleMinutes: 1',
    '      autopilot:',
    '        throttle: false',
    '        pause: false',
    '        pauseOnHardLimit: true',
    '        abortOnHardLimit: true',
    '- id: dsh-overwatch-m2-harness',
    '  config:',
    `    port: ${port}`,
    '    token: m2-swarm-token',
  ].join('\n') + '\n', 'utf8')
  return profileDir
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} file */
function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** @param {string} file @param {string} runId */
function verifyChain(file, runId) {
  try {
    const parsed = parseChain(readFileSync(file, 'utf8'), runId)
    return {
      ok: parsed.error === null,
      count: parsed.events.length,
      error: parsed.error === null ? null : `${parsed.error.code} at line ${parsed.error.line}: ${parsed.error.message}`,
      events: parsed.events,
    }
  } catch (error) {
    return { ok: false, count: 0, error: error instanceof Error ? error.message : String(error), events: [] }
  }
}

/** @param {any[]} events @param {string} type */
function ofType(events, type) {
  return events.filter(event => event.type === type)
}

/** @param {any} report */
function gateOf(report) {
  const failed = Object.entries(report.checks).filter(([, check]) => check.status !== 'pass').map(([id]) => id)
  return { ok: failed.length === 0, failed, total: Object.keys(report.checks).length }
}

async function main() {
  const startedAt = new Date()
  const startedMs = Date.now()
  const port = await freePort()
  const summary = {
    schemaVersion: 1,
    stage: 'headless-m2',
    dshVersion: 'unknown',
    port,
    temp,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    error: null,
    checks: {},
    gate: null,
    published: publishedDir,
  }
  let profileDir = null
  let run = null
  let report = null
  try {
    summary.dshVersion = (runCli(['--version']).stdout || '').trim() || 'unknown'
    console.log(`m2: DSH ${summary.dshVersion}; fake swarm on 127.0.0.1:${port}`)
    profileDir = createProfile(port)
    console.log('m2: running the headless supervised probe')
    run = runCli(['--profile', PROFILE, 'M2-ROOT: arm the run in supervised mode and let the watch officer decide, then disarm.'], { timeout: 180_000 })
    writeFileSync(path.join(resultsDir, 'run.log'), `--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`, 'utf8')
    report = buildReport({ run, port, dshVersion: summary.dshVersion })
    summary.checks = report.checks
    summary.gate = gateOf(report)
    summary.watch = report.watch.summary
    summary.calls = report.actions.calls
    summary.tools = report.tools
    console.log(`m2: checks: ${Object.entries(report.checks).map(([id, check]) => `${id}=${check.status}`).join(' ')}`)
    if (summary.gate.ok) console.log('m2: gate PASS')
    else console.error(`m2: gate FAIL (${summary.gate.failed.join(', ')})`)
  } catch (error) {
    summary.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error(`m2: FAIL: ${summary.error}`)
  } finally {
    summary.durationMs = Date.now() - startedMs
    summary.finishedAt = new Date().toISOString()
    const exitCode = summary.error === null && summary.gate?.ok === true ? 0 : 1
    summary.exitCode = exitCode
    rmSync(publishedDir, { recursive: true, force: true })
    mkdirSync(publishedDir, { recursive: true })
    try {
      if (report !== null) writeFileSync(path.join(publishedDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      for (const name of ['calls.json', 'llm.jsonl', 'run.log']) {
        const file = path.join(resultsDir, name)
        if (existsSync(file)) copyFileSync(file, path.join(publishedDir, name))
      }
      const watchFile = path.join(home, 'overwatch', 'runs', WATCH_RUN, 'watch.jsonl')
      if (existsSync(watchFile)) copyFileSync(watchFile, path.join(publishedDir, 'watch.jsonl'))
      const shiftDir = path.join(home, 'overwatch', 'runs', WATCH_RUN, 'shifts')
      if (existsSync(shiftDir)) {
        for (const name of readdirSync(shiftDir)) {
          if (name.endsWith('.md')) copyFileSync(path.join(shiftDir, name), path.join(publishedDir, name))
        }
      }
      if (profileDir !== null) {
        const patch = path.join(profileDir, 'cordis.patch.yml')
        if (existsSync(patch)) copyFileSync(patch, path.join(publishedDir, 'profile-cordis.patch.yml'))
        const manifest = path.join(profileDir, 'package.json')
        if (existsSync(manifest)) copyFileSync(manifest, path.join(publishedDir, 'profile-package.json'))
      }
    } catch (error) {
      summary.publishError = error instanceof Error ? error.message : String(error)
    }
    writeFileSync(path.join(publishedDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    if (!keep) {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch (error) {
        console.error(`m2: could not remove ${temp}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      console.log(`m2: kept ${temp}`)
    }
    console.log(`m2: evidence in ${publishedDir}`)
    process.exitCode = exitCode
  }
}


/**
 * @param {{ run: any, port: number, dshVersion: string }} input
 */
function buildReport(input) {
  const watchFile = path.join(home, 'overwatch', 'runs', WATCH_RUN, 'watch.jsonl')
  const chain = verifyChain(watchFile, WATCH_RUN)
  const calls = readJson(path.join(resultsDir, 'calls.json'))?.calls ?? []
  const llm = readJsonl(path.join(resultsDir, 'llm.jsonl'))
  const watchRequests = llm.filter(record => Array.isArray(record.toolNames) && record.toolNames.includes('watch_decide'))
  const firstWatchTools = watchRequests.length === 0 ? [] : [...watchRequests[0].toolNames].sort()
  const forbidden = ['watch_arm', 'bash', 'write', 'subagent', 'swarm_merge', 'swarm_start']
  const leaked = firstWatchTools.filter(name => forbidden.includes(name))
  const events = chain.events
  const armed = ofType(events, 'watch/armed')[0] ?? null
  const decision = ofType(events, 'watch/decision')[0] ?? null
  const types = events.map(event => event.type)
  const caseClosed = ofType(events, 'watch/case/closed')[0] ?? null
  const shift = ofType(events, 'watch/shift')[0] ?? null
  const usage = ofType(events, 'watch/usage').at(-1) ?? null
  const intended = ofType(events, 'watch/action/intended')[0] ?? null
  const executed = ofType(events, 'watch/action/executed')[0] ?? null
  const verified = ofType(events, 'watch/action/verified')[0] ?? null
  const steer = calls.find(call => call.action === 'steer') ?? null

  /** @type {Record<string, { status: 'pass'|'fail'|'blocked', evidence: any }>} */
  const checks = {
    'run-exit': check(input.run.status === 0, { exit: input.run.status, stderr: tail(input.run.stderr) }),
    'chain-ok': check(chain.ok && chain.count > 0, { ok: chain.ok, count: chain.count, error: chain.error }),
    'armed-supervised': check(armed !== null && armed.payload?.mode === 'supervised' && typeof armed.payload?.watchName === 'string', { armed: armed?.payload ?? null }),
    'case-opened': check(types.includes('watch/case/opened'), { opened: ofType(events, 'watch/case/opened').length }),
    'wake-recorded': check(types.includes('watch/wake'), { wakes: ofType(events, 'watch/wake').length }),
    'watch-decision': check(decision !== null && decision.payload?.action === 'coach' && decision.payload?.accepted === true, { decision: decision?.payload ?? null }),
    'action-chain': check(intended !== null && executed !== null && verified !== null, {
      intended: intended?.payload ?? null,
      executed: executed?.payload ?? null,
      verified: verified?.payload ?? null,
    }),
    'swarm-steer': check(steer !== null && String(steer.body?.text ?? '').length > 20, { steer: steer?.body ?? null }),
    'watch-tools-only': check(watchRequests.length > 0 && leaked.length === 0, { firstWatchTools, leaked, requests: watchRequests.length }),
    'usage-accounted': check(usage !== null && Number(usage.payload?.spent ?? 0) > 0, { usage: usage?.payload ?? null }),
    'case-closed': check(caseClosed !== null && caseClosed.payload?.reason === 'mitigated', { closed: caseClosed?.payload ?? null }),
    'shift-written': check(shift !== null && typeof shift.payload?.shiftId === 'string' && Number(shift.payload?.summary?.wakes ?? 0) >= 1, { shift: shift?.payload ?? null }),
  }
  return {
    schemaVersion: 1,
    stage: 'headless-m2',
    startedAt: new Date().toISOString(),
    dshVersion: input.dshVersion,
    port: input.port,
    checks,
    watch: {
      summary: { ok: chain.ok, count: chain.count, types, armed: armed?.payload ?? null, decision: decision?.payload ?? null },
      events: events.map(event => ({ seq: event.seq, type: event.type, at: event.at, actor: event.actor, payload: event.payload })),
    },
    actions: { calls },
    tools: { firstWatchTools, leaked, requests: watchRequests.map(record => ({ sessionId: record.sessionId, call: record.call, toolNames: record.toolNames })) },
    errors: [],
  }
}

/** @param {boolean} ok @param {any} evidence */
function check(ok, evidence) {
  return { status: ok ? 'pass' : 'fail', evidence }
}

/** @param {string} value */
function tail(value) {
  return String(value ?? '').slice(-1_500)
}

await main()
