#!/usr/bin/env node
/**
 * Install the packed release into a throwaway DSH profile and verify the
 * package, bundle row and client artifact are present. This is the release
 * smoke test that runs before `npm publish`.
 *
 * Usage:
 *   node scripts/smoke-install.mjs [--package <dir|tgz>]
 *
 * Defaults to the newest `dist/*` directory; requires the packaged Desktop DSH
 * (DSH_DESKTOP_ROOT may override the install root). It never touches the user's
 * profile and removes its temporary DSH_HOME on success.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const packageArgIndex = args.indexOf('--package')
const repoRoot = path.resolve(import.meta.dirname, '..')
let packagePath = packageArgIndex >= 0 ? path.resolve(args[packageArgIndex + 1]) : null
if (packagePath === null) {
  const dist = path.join(repoRoot, 'dist')
  const entries = existsSync(dist) ? readdirSync(dist, { withFileTypes: true }).filter(entry => entry.isDirectory()) : []
  if (entries.length === 0) {
    console.error('smoke-install: no dist/* build; run npm run build:release first')
    process.exit(2)
  }
  packagePath = path.join(dist, entries.sort((left, right) => right.name.localeCompare(left.name))[0].name)
}
if (!existsSync(packagePath)) {
  console.error(`smoke-install: package not found: ${packagePath}`)
  process.exit(2)
}

const desktopRoot = process.env.DSH_DESKTOP_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const cli = path.join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
if (!existsSync(executable)) {
  console.error(`smoke-install: cannot find Desktop DSH under ${desktopRoot}`)
  process.exit(2)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'overwatch-smoke-'))
const home = path.join(temp, 'home')
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))

/** @param {string[]} cliArgs */
function run(cliArgs) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...cliArgs], {
    cwd: temp,
    env: { ...cleanEnv, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

try {
  const profile = 'overwatch-smoke'
  const created = run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  if (created.status !== 0) throw new Error(`profile creation failed (${created.status}): ${created.stderr.slice(-1_500)}`)
  const added = run(['plugin', '--profile', profile, 'add', packagePath])
  if (added.status !== 0) throw new Error(`plugin add failed (${added.status}): ${added.stderr.slice(-1_500)}`)

  const profileDir = path.join(home, 'profiles', profile)
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  const source = packageManifest(packagePath)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(source.name)) throw new Error(`bundle ${source.name} is missing from profile bundles`)
  const installed = path.join(profileDir, 'node_modules', ...source.name.split('/'))
  for (const file of ['package.json', 'client.js', 'cordis.patch.yml', 'src/index.js', 'icon.svg']) {
    if (!existsSync(path.join(installed, file))) throw new Error(`installed package is missing ${file}`)
  }
  const installedPkg = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'))
  if (installedPkg.name !== source.name) throw new Error('installed package name mismatch')
  const patch = readFileSync(path.join(installed, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes(`name: '${source.name}'`)) throw new Error('bundle row name was not rewritten')
  const client = readFileSync(path.join(installed, 'client.js'), 'utf8')
  if (!client.includes(`id: '${source.name}'`)) throw new Error('client module id was not rewritten')
  console.log(`smoke-install: PASS ${source.name}@${source.version} (${packagePath})`)
  console.log(`  profile: ${profileDir}`)
} catch (error) {
  console.error(`smoke-install: FAIL ${error instanceof Error ? error.message : String(error)}`)
  console.error(`  temp home kept for inspection: ${home}`)
  process.exitCode = 1
} finally {
  if (process.exitCode !== 1) rmSync(temp, { recursive: true, force: true })
}

/**
 * Read the package manifest from a build directory or a packed tarball.
 * @param {string} target
 * @returns {{ name: string, version: string }}
 */
function packageManifest(target) {
  if (statSync(target).isDirectory()) return JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))
  const tar = spawnSync('tar', ['-xOf', target, 'package/package.json'], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`cannot read package.json from tarball: ${String(tar.stderr).slice(0, 300)}`)
  return JSON.parse(tar.stdout)
}
