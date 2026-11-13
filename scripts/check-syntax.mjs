/**
 * Syntax gate: `node --check` every source file we ship or test.
 * The plugin intentionally has no runtime dependencies, so this is the lint.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['src', 'test', 'scripts', 'e2e']
const files = []
for (const dir of roots) walk(path.join(root, dir))
files.push(path.join(root, 'src', 'index.js'))

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    console.error(`syntax error in ${path.relative(root, file)}`)
    console.error(result.stderr.trim())
  }
}
if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax checks`)
  process.exit(1)
}
console.log(`syntax ok: ${files.length} files`)

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full)
  }
}
