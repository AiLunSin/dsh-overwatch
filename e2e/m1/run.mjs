/**
 * M1 runner: install a throwaway Web profile in the real packaged Desktop DSH,
 * run the M1 probe against the real Host web server, and publish the evidence.
 *
 * Usage:
 *   node e2e/m1/run.mjs [--keep]
 *
 * Prerequisites: the packaged Desktop install (default
 * `%LOCALAPPDATA%\Programs\DeepSeek Harness`, or `DSH_DESKTOP_ROOT`). No model
 * account, network, or token spend is used: the profile mounts a fake swarm HTTP
 * surface and a probe, not a model provider.
 *
 * Layout: `e2e/m1/fake-swarm` (fake swarm), `e2e/m1/probe` (checks), this file
 * (profile + web stage + publication). Only Web is exercised; headless has no
 * Host web server and is covered by M0.
 * @module dsh-overwatch/e2e/m1/run
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')
const PROFILE = 'm1web'
const REPORT_WAIT_MS = 120_000

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

if (!existsSync(executable) || !existsSync(path.join(desktopRoot, 'resources', 'app.asar'))) {
  console.error(`m1: cannot find the Desktop installation under ${desktopRoot}`)
  console.error('    set DSH_DESKTOP_ROOT to the install root (the directory containing "DeepSeek Harness.exe")')
  process.exit(1)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'overwatch-m1-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
const resultsDir = path.join(temp, 'results')
const publishedDir = path.join(repoRoot, 'e2e', 'm1', 'results')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(resultsDir, { recursive: true })

// The runner itself may be launched from a DSH session; do not leak that
// session's profile, install anchor, permission mode, or previous M1 env.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !key.startsWith('OVERWATCH_M1_')),
)

const packageDir = repoRoot
const fakeSwarmDir = path.join(repoRoot, 'e2e', 'm1', 'fake-swarm')
const probeDir = path.join(repoRoot, 'e2e', 'm1', 'probe')
const bundles = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-overwatch',
  'dsh-overwatch-m1-fake-swarm',
  'dsh-overwatch-m1-probe',
]

/** @param {string[]} args @param {{ cwd?: string, timeout?: number, env?: Record<string, string> }} [options] */
function runCli(args, options = {}) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: options.cwd ?? temp,
    env: { ...cleanEnv, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
    error: result.error ?? null,
  }
}

/** @param {string[]} args @param {{ cwd?: string, timeout?: number, env?: Record<string, string> }} [options] */
function mustRun(args, options) {
  const result = runCli(args, options)
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`
    throw new Error(`dsh ${args.join(' ')} exited ${result.status}${result.signal ? ` (${result.signal})` : ''}:\n${output.slice(-4_000)}`)
  }
  return result
}

/** @param {string[]} lines @param {string} profileDir */
function writeProfilePatch(profileDir, lines) {
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8')
}

/**
 * Create the throwaway profile from the shipped Web template, add the local
 * packages, then override the bundle list and the two plugin configs.
 * @returns {string} profile directory
 */
function createProfile() {
  mustRun(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  mustRun(['plugin', '--profile', PROFILE, 'add', packageDir, fakeSwarmDir, probeDir], { timeout: 300_000 })
  const profileDir = path.join(home, 'profiles', PROFILE)
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh === undefined || manifest.dsh.profile === undefined) {
    throw new Error(`profile manifest ${manifestPath} has no dsh.profile section`)
  }
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeProfilePatch(profileDir, [
    '# M1 e2e overrides. Test values only: these tokens are not secrets.',
    '# thresholds stay at the bundle defaults (budgetPressure 0.80 / budgetPause 0.95).',
    '- id: dsh-overwatch',
    '  config:',
    '    enabled: true',
    '    mode: guard',
    '    http:',
    '      token: m1-token',
    '    ports:',
    '      swarmToken: m1-swarm-token',
    '    sampling:',
    '      swarmEventMs: 500',
    '      swarmSnapshotMs: 500',
    '      pressureMs: 500',
    '      fishMs: 500',
    '      staleMs: 5000',
    '      requestTimeoutMs: 3000',
    '      maxInflight: 4',
    '    policy:',
    '      throttleMinutes: 1',
    '      autopilot:',
    '        throttle: false',
    '- id: dsh-overwatch-m1-fake-swarm',
    '  config:',
    '    token: m1-swarm-token',
  ])
  return profileDir
}

/** @param {string} file */
function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A reader can observe an atomic-write temp file only through a torn read
    // on unusual filesystems; the caller simply retries on the next poll.
    return null
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {unknown} value */
function redact(value) {
  return String(value ?? '').replace(/([?&]token=)[^&\s"]+/g, '$1<redacted>')
}

/**
 * Stop the web host and its children. On Windows, killing the Electron process
 * alone can leave the Node host child behind; `taskkill /T /F` removes the tree.
 * @param {import('node:child_process').ChildProcess} child
 */
async function stopChild(child) {
  const pid = child.pid
  try {
    child.kill()
  } catch (error) {
    console.error(`m1: could not signal the web host: ${error instanceof Error ? error.message : String(error)}`)
  }
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(1_500),
  ])
  if (process.platform === 'win32' && pid !== undefined) {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    // 128 means "process not found": the child already exited, which is the
    // common case once the probe finishes. Anything else is worth a warning.
    if (killed.status !== 0 && killed.status !== 128) {
      const detail = `${killed.stdout ?? ''}${killed.stderr ?? ''}`.trim()
      console.error(`m1: taskkill exited ${String(killed.status)}${detail === '' ? '' : `: ${detail}`}`)
    }
    // Give the OS a moment to release the host's file handles before cleanup.
    await delay(500)
  }
}

/**
 * Start the Web host in the throwaway profile, wait for the probe's report to
 * reach `finishedAt !== null`, then kill the process tree.
 * @returns {Promise<{ report: any, finished: boolean, error: string | null, stdout: string, stderr: string, dataDir: string, profileDir: string, logPath: string }>}
 */
async function runWeb(profileDir) {
  const logPath = path.join(resultsDir, 'run.log')
  const reportPath = path.join(resultsDir, 'report.json')
  const dataDir = path.join(home, 'overwatch')
  const stdout = []
  const stderr = []
  const child = spawn(executable, ['--expose-internals', cli, '--profile', PROFILE, '--port', '0', '--no-open'], {
    cwd: work,
    env: {
      ...cleanEnv,
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
      OVERWATCH_M1_STAGE: 'web',
      OVERWATCH_M1_OUT: reportPath,
      OVERWATCH_M1_DATA: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => stdout.push(String(chunk)))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  /** @type {Error | null} */
  let spawnError = null
  child.once('error', error => {
    spawnError = error
  })
  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | null} */
  let exitInfo = null
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal }
  })

  const deadline = Date.now() + REPORT_WAIT_MS
  let report = null
  let finished = false
  while (Date.now() < deadline) {
    report = readJson(reportPath)
    if (report !== null && report.finishedAt !== null && report.finishedAt !== undefined) {
      finished = true
      break
    }
    if (spawnError !== null || exitInfo !== null) break
    await delay(250)
  }

  await stopChild(child)
  const combined = `--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}\n`
  writeFileSync(logPath, redact(combined), 'utf8')

  if (report === null) report = readJson(reportPath)
  /** @type {string | null} */
  let error = null
  if (spawnError !== null) {
    error = `m1: could not start the web host: ${spawnError.message}`
  } else if (!finished) {
    const tail = redact(stderr.join('').trim().slice(-2_000))
    if (exitInfo !== null) {
      error = `m1: web host exited (code ${String(exitInfo.code)}, signal ${String(exitInfo.signal)}) before the probe finished${tail === '' ? '' : `:\n${tail}`}`
    } else {
      error = `m1: the probe did not finish within ${REPORT_WAIT_MS / 1000}s; see ${logPath}${tail === '' ? '' : `\n${tail}`}`
    }
  } else if (report === null) {
    error = `m1: probe finished but no report was readable at ${reportPath}`
  }
  return { report, finished, error, stdout: stdout.join(''), stderr: stderr.join(''), dataDir, profileDir, logPath }
}

/** @param {string} dir @param {string} name @param {number} [depth] @returns {string[]} */
function findNamedFiles(dir, name, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return []
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...findNamedFiles(full, name, depth + 1))
    else if (entry.isFile() && entry.name === name) files.push(full)
  }
  return files
}

/**
 * @param {string} dataDir
 * @param {string} targetDir
 * @returns {string[]} published watch file names
 */
function publishWatchFiles(dataDir, targetDir) {
  const watchFiles = findNamedFiles(dataDir, 'watch.jsonl')
  watchFiles.sort()
  /** @type {string[]} */
  const published = []
  for (const file of watchFiles) {
    const relative = path.relative(dataDir, file)
    const name = relative.includes('swarm_m1') ? 'watch.jsonl' : `watch-${relative.replace(/[\\/]/g, '_')}`
    copyFileSync(file, path.join(targetDir, name))
    published.push(name)
  }
  return published
}

/**
 * @param {any} report
 * @returns {{ ok: boolean, failed: string[], total: number, reason: string | null }}
 */
function computeGate(report) {
  if (report === null) return { ok: false, failed: [], total: 0, reason: 'probe wrote no report' }
  if (report.finishedAt === null || report.finishedAt === undefined) {
    return { ok: false, failed: [], total: Object.keys(report.checks ?? {}).length, reason: 'probe report has no finishedAt' }
  }
  const entries = Object.entries(report.checks ?? {})
  const failed = entries.filter(([, value]) => value?.status !== 'pass').map(([id]) => id)
  const gate = report.gate ?? null
  if (gate !== null && gate.ok === true && failed.length === 0) {
    return { ok: true, failed, total: entries.length, reason: null }
  }
  return { ok: false, failed, total: entries.length, reason: gate === null ? 'checks did not all pass' : `checks did not all pass: ${failed.join(', ')}` }
}

/** @param {any} report */
function checkSummary(report) {
  if (report === null) return 'no report'
  const checks = report.checks ?? {}
  const entries = Object.entries(checks)
  if (entries.length === 0) return 'no checks'
  return entries.map(([id, value]) => `${id}=${value?.status ?? 'unknown'}`).join(' ')
}

async function main() {
  const startedAt = new Date()
  const startedMs = Date.now()
  const summary = {
    schemaVersion: 1,
    stage: 'web',
    dshVersion: 'unknown',
    desktopRoot,
    temp,
    profile: PROFILE,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
    gate: null,
    checks: {},
    report: null,
    watchFiles: [],
    published: publishedDir,
  }
  let profileDir = null
  let run = null

  try {
    summary.dshVersion = (runCli(['--version']).stdout || '').trim() || 'unknown'
    console.log(`m1: DSH ${summary.dshVersion}`)
    console.log(`m1: throwaway home ${home}`)
    console.log('m1: preparing the Web profile (real Desktop DSH, fake swarm + probe plugins)')
    profileDir = createProfile()
    console.log('m1: starting the real Web host and waiting for the probe (max 120s)')
    run = await runWeb(profileDir)
    summary.report = run.report
    summary.checks = run.report?.checks ?? {}
    summary.gate = computeGate(run.report)
    if (run.report !== null) {
      console.log(`m1: http: ${JSON.stringify(Object.fromEntries(Object.entries(run.report.http ?? {}).map(([id, value]) => [id, value?.status])))}`)
      console.log(`m1: checks: ${checkSummary(run.report)}`)
    } else {
      console.log('m1: no probe report was written')
    }
    if (run.error !== null) throw new Error(run.error)
    if (summary.gate.ok) console.log('m1: gate PASS')
    else console.error(`m1: gate FAIL (${summary.gate.reason ?? 'unknown'})`)
  } catch (error) {
    summary.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error(`m1: FAIL: ${summary.error}`)
  } finally {
    summary.durationMs = Date.now() - startedMs
    summary.finishedAt = new Date().toISOString()
    const reportOk = run !== null && summary.gate !== null && summary.gate.ok === true
    const exitCode = summary.error === null && reportOk ? 0 : 1
    summary.exitCode = exitCode

    rmSync(publishedDir, { recursive: true, force: true })
    mkdirSync(publishedDir, { recursive: true })
    /** @type {string[]} */
    const publishErrors = []
    if (run !== null) {
      try {
        if (existsSync(path.join(resultsDir, 'report.json'))) {
          copyFileSync(path.join(resultsDir, 'report.json'), path.join(publishedDir, 'report.json'))
        }
        summary.watchFiles = publishWatchFiles(run.dataDir, publishedDir)
      } catch (error) {
        publishErrors.push(`evidence: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        if (existsSync(run.logPath)) copyFileSync(run.logPath, path.join(publishedDir, 'run.log'))
      } catch (error) {
        publishErrors.push(`run log: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (profileDir !== null) {
      try {
        const patchPath = path.join(profileDir, 'cordis.patch.yml')
        if (existsSync(patchPath)) copyFileSync(patchPath, path.join(publishedDir, 'profile-cordis.patch.yml'))
        const manifestPath = path.join(profileDir, 'package.json')
        if (existsSync(manifestPath)) copyFileSync(manifestPath, path.join(publishedDir, 'profile-package.json'))
      } catch (error) {
        publishErrors.push(`profile: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (publishErrors.length > 0) {
      summary.publishErrors = publishErrors
      for (const message of publishErrors) console.error(`m1: publish warning: ${message}`)
    }
    writeFileSync(path.join(publishedDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    if (!keep) {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch (error) {
        console.error(`m1: could not remove ${temp}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      console.log(`m1: kept ${temp}`)
    }
    console.log(`m1: evidence in ${publishedDir}`)
    process.exitCode = exitCode
  }
}

await main()
