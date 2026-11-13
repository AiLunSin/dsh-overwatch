/**
 * M0 runner: install a throwaway profile, run the probe in headless and web
 * modes against the real Desktop DSH install, and collect the evidence.
 *
 * Usage:
 *   node e2e/m0/run.mjs [--keep] [--strict] [--only=headless|web]
 *
 * Requires the packaged Desktop install (default %LOCALAPPDATA%\Programs\
 * DeepSeek Harness) or `DSH_DESKTOP_ROOT`. No model account, network, or token
 * spend is used: the profile mounts a scripted provider.
 * @module dsh-overwatch/e2e/m0/run
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')
const strict = process.argv.includes('--strict')
const onlyArg = process.argv.find(argument => argument.startsWith('--only='))
const only = onlyArg?.split('=')[1] ?? null

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

if (!existsSync(executable) || !existsSync(path.join(desktopRoot, 'resources', 'app.asar'))) {
  console.error(`m0: cannot find the Desktop installation under ${desktopRoot}`)
  console.error('    set DSH_DESKTOP_ROOT to the install root (the directory containing "DeepSeek Harness.exe")')
  process.exit(2)
}
const temp = mkdtempSync(path.join(os.tmpdir(), 'overwatch-m0-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
const resultsDir = path.join(temp, 'results')
mkdirSync(resultsDir, { recursive: true })

// The runner itself may be launched from a DSH session; do not leak that
// session's profile, install anchor, or permission mode into the throwaway boot.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))

const probeDir = path.join(repoRoot, 'e2e', 'm0', 'probe')
const fakeDir = path.join(repoRoot, 'e2e', 'm0', 'fake-llm')
const swarmDir = path.join(process.env.OVERWATCH_M0_SWARM_DIR ?? 'C:\\Users\\11403\\Desktop\\em\\dsh-swarm')
const fishDir = path.join(process.env.OVERWATCH_M0_FISH_DIR ?? 'C:\\Users\\11403\\Desktop\\huanjing\\fish-keeper-console')

console.log(`m0: install ${desktopRoot}`)
console.log(`m0: throwaway home ${home}`)

/** @param {string[]} args @param {{ cwd?: string, timeout?: number, env?: Record<string,string> }} [options] */
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

function mustRun(args, options) {
  const result = runCli(args, options)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} exited ${result.status}${result.signal ? ` (${result.signal})` : ''}:\n${output.slice(-4_000)}`)
  }
  return result
}

const dshVersion = (runCli(['--version']).stdout || '').trim() || 'unknown'
console.log(`m0: DSH ${dshVersion}`)

/** @param {string} profile @param {'headless'|'web'} template @param {string[]} bundles @param {string[]} packages */
function createProfile(profile, template, bundles, packages) {
  mustRun(['--profile', profile, '--from-default-profile', template, '--dump-config'])
  mustRun(['plugin', '--profile', profile, 'add', ...packages], { timeout: 300_000 })
  const profileDir = path.join(home, 'profiles', profile)
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return profileDir
}

/** @param {string} profileDir @param {string[]} lines */
function writeProfilePatch(profileDir, lines) {
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8')
}

/** @param {string} profile @param {Record<string,string>} env @param {string} task */
function runHeadless(profile, env, task) {
  const outputPath = path.join(resultsDir, 'headless-run.log')
  const result = runCli(['--profile', profile, task], { cwd: work, env })
  writeFileSync(outputPath, `${result.stdout}\n--- stderr ---\n${result.stderr}\n`, 'utf8')
  return result
}

/** @param {string} profile @param {Record<string,string>} env */
async function runWeb(profile, env) {
  const stdoutPath = path.join(resultsDir, 'web-run.log')
  const stderrPath = path.join(resultsDir, 'web-run.err.log')
  const output = []
  const errors = []
  const child = spawn(executable, ['--expose-internals', cli, '--profile', profile, '--port', '0', '--no-open'], {
    cwd: work,
    env: { ...cleanEnv, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => output.push(String(chunk)))
  child.stderr.on('data', chunk => errors.push(String(chunk)))
  const reportPath = env.OVERWATCH_M0_OUT
  const deadline = Date.now() + 90_000
  let finished = false
  while (Date.now() < deadline) {
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'))
        if (report.finishedAt !== null) {
          finished = true
          break
        }
      } catch {
        // still writing
      }
    }
    await delay(250)
  }
  const pid = child.pid
  child.kill()
  await delay(1_000)
  if (process.platform === 'win32' && pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  }
  writeFileSync(stdoutPath, `${redact(output.join(''))}\n`, 'utf8')
  writeFileSync(stderrPath, `${redact(errors.join(''))}\n`, 'utf8')
  if (!finished) throw new Error(`web stage did not finish within 90s; see ${stderrPath}`)
  return { output: output.join(''), errors: errors.join('') }
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} profileDir @param {string} name */
function copyEvidence(profileDir, name, dataDir = path.join(home, 'overwatch', 'm0')) {
  const candidates = [
    path.join(dataDir, 'watch.jsonl'),
    path.join(profileDir, 'cordis.patch.yml'),
    path.join(profileDir, 'package.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const target = path.join(resultsDir, `${name}-${path.basename(candidate)}`)
      copyFileSync(candidate, target)
    }
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

/** @param {ReturnType<typeof createProfile>} profileDir @param {string} stage */
function basePatchLines(profileDir, stage) {
  return [
    ...stage === 'headless'
      ? [
          '- insert:',
          '    - id: m0-agent-preset-registry',
          "      name: '@deepseek-ai/dsh-agent-preset-registry'",
          '      config:',
          '        default: m0-watch',
          '    - id: m0-preset',
          "      name: '@deepseek-ai/dsh-agent-preset'",
          '      config:',
          '        id: m0-watch',
          '        name: M0 watch probe',
          '        plugins: []',
        ]
      // The shipped Web app already mounts the preset registry; a second
      // declaration is rejected at activation.
      : [],
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- id: subagent',
    '  config:',
    '    maxActiveSubagents: 3',
  ]
}

async function main() {
  const startedAt = Date.now()
  const summary = { version: dshVersion, temp, headless: null, web: null, error: null }

  try {
    if (only === null || only === 'headless') {
      console.log('m0: preparing headless profile')
      const profileDir = createProfile('m0', 'headless', [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
        'dsh-swarm',
        'dsh-overwatch',
        'dsh-fake-llm',
        'dsh-overwatch-m0-probe',
      ], [repoRoot, probeDir, fakeDir, swarmDir])
      copyEvidence(profileDir, 'headless-profile')
      writeProfilePatch(profileDir, basePatchLines(profileDir, 'headless'))

      const out = path.join(resultsDir, 'headless-report.json')
      const llmLog = path.join(resultsDir, 'headless-llm.jsonl')
      console.log('m0: running headless probe (this starts real DSH turns with a scripted provider)')
      const run = runHeadless('m0', {
        OVERWATCH_M0_STAGE: 'headless',
        OVERWATCH_M0_OUT: out,
        OVERWATCH_M0_LLM_LOG: llmLog,
        OVERWATCH_M0_DATA: path.join(home, 'overwatch', 'm0'),
      }, 'M0 probe: reply with root ok and stop.')
      summary.headless = { exit: run.status, report: readJson(out), stdout: redact(run.stdout.trim().slice(-2_000)), stderr: redact(run.stderr.trim().slice(-2_000)) }
      if (run.status !== 0) throw new Error(`headless probe exited ${run.status}:\n${run.stderr.slice(-3_000)}`)
      if (summary.headless.report === null) throw new Error(`headless probe wrote no report at ${out}`)
      copyEvidence(profileDir, 'headless')
      if (existsSync(out)) copyFileSync(out, path.join(resultsDir, 'headless.json'))
      if (existsSync(llmLog)) copyFileSync(llmLog, path.join(resultsDir, 'headless-llm-copy.jsonl'))
      console.log('m0: headless checks:', summarize(summary.headless.report))
    }

    if (only === null || only === 'web') {
      console.log('m0: preparing web profile')
      const profileDir = createProfile('m0web', 'web', [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dsh-swarm',
        'dsh-overwatch',
        'dsh-fake-llm',
        'dsh-overwatch-m0-probe',
        'dsh-fishkeeper',
      ], [repoRoot, probeDir, fakeDir, swarmDir, fishDir])
      copyEvidence(profileDir, 'web-profile')
      writeProfilePatch(profileDir, basePatchLines(profileDir, 'web'))
      const out = path.join(resultsDir, 'web-report.json')
      const llmLog = path.join(resultsDir, 'web-llm.jsonl')
      console.log('m0: starting the web host briefly for HTTP checks')
      const run = await runWeb('m0web', {
        OVERWATCH_M0_STAGE: 'web',
        OVERWATCH_M0_OUT: out,
        OVERWATCH_M0_LLM_LOG: llmLog,
        OVERWATCH_M0_DATA: path.join(home, 'overwatch', 'm0-web'),
      })
      summary.web = { report: readJson(out), stdout: redact(run.output.trim().slice(-2_000)), stderr: redact(run.errors.trim().slice(-2_000)) }
      if (summary.web.report === null) throw new Error(`web probe wrote no report at ${out}`)
      copyEvidence(profileDir, 'web', path.join(home, 'overwatch', 'm0-web'))
      if (existsSync(out)) copyFileSync(out, path.join(resultsDir, 'web.json'))
      console.log('m0: web checks:', summarize(summary.web.report))
    }
  } catch (error) {
    summary.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error(`m0: FAIL 閳?${summary.error}`)
  } finally {
    summary.durationMs = Date.now() - startedAt
    writeFileSync(path.join(resultsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

    // Publish only the evidence files, not the whole throwaway home.
    const published = path.join(repoRoot, 'e2e', 'm0', 'results')
    rmSync(published, { recursive: true, force: true })
    mkdirSync(published, { recursive: true })
    for (const file of ['headless.json', 'web.json', 'summary.json', 'headless-run.log', 'web-run.log', 'web-run.err.log', 'headless-llm.jsonl', 'headless-watch.jsonl', 'web-watch.jsonl']) {
      const source = path.join(resultsDir, file)
      if (existsSync(source)) copyFileSync(source, path.join(published, file))
    }
    if (!keep) rmSync(temp, { recursive: true, force: true })
    else console.log(`m0: kept ${temp}`)
    console.log(`m0: evidence in ${published}`)
    if (strict && summary.error !== null) process.exitCode = 1
    else if (only === null && summary.headless === null && summary.web === null) process.exitCode = 1
  }
}

/** @param {any} report */
function summarize(report) {
  if (report === null || report === undefined) return 'no report'
  const checks = report.checks ?? {}
  const parts = Object.entries(checks).map(([id, value]) => `${id}=${value.status}`)
  return parts.length > 0 ? parts.join(' ') : 'no checks'
}

await main()
