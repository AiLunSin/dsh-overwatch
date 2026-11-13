import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FileLock } from '../src/util.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-lock-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const helper = fileURLToPath(new URL('./helpers/lock-contender.mjs', import.meta.url))

test('a lock is exclusive and releasable', async () => {
  const dir = tempDir()
  const lock = new FileLock({ dir, name: 'watch', waitMs: 0 })
  await lock.acquire()
  const rival = new FileLock({ dir, name: 'watch', waitMs: 0 })
  await assert.rejects(() => rival.acquire(), error => error.code === 'ELOCKED')
  lock.release()
  await rival.acquire()
  rival.release()
})

test('a dead owner lock is taken over', async () => {
  const dir = tempDir()
  const lockPath = path.join(dir, 'watch.lock')
  mkdirSync(lockPath)
  writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    pid: 999_999,
    host: os.hostname(),
    nonce: 'dead',
    acquiredAt: new Date(0).toISOString(),
  }))
  const lock = new FileLock({ dir, name: 'watch', waitMs: 0, staleMs: 1 })
  await lock.acquire()
  assert.equal(lock.nonce === null, false)
  lock.release()
})

test('only one of several processes acquires the same lock', async () => {
  const dir = tempDir()
  const results = path.join(dir, 'results')
  mkdirSync(results)
  const children = []
  for (let index = 0; index < 6; index += 1) {
    children.push(runHelper(dir, results, index))
  }
  const outcomes = await Promise.all(children)
  const acquired = outcomes.filter(outcome => outcome.code === 0)
  assert.equal(acquired.length, 1, `expected exactly one winner, got ${JSON.stringify(outcomes)}`)
  const marker = readFileSync(path.join(results, 'winner.txt'), 'utf8').trim()
  assert.equal(marker.startsWith('winner:'), true)
})

/** @param {string} dir @param {string} results @param {number} index */
function runHelper(dir, results, index) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [helper, dir, results, String(index)], { stdio: 'ignore' })
    child.on('exit', code => resolve({ index, code }))
    child.on('error', error => resolve({ index, code: -1, error: String(error) }))
  })
}
