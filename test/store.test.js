import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { WatchStore } from '../src/store.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-store-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('append builds a verifiable chain and persists across reopen', async () => {
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-a', lockWaitMs: 10 })
  await store.open()
  const first = store.append({ type: 'watch/armed', actor: 'system', payload: { mode: 'guard' } })
  const second = store.append({ type: 'watch/case/opened', actor: 'guard', payload: { caseId: 'case-1' } })
  assert.equal(first.seq, 1)
  assert.equal(first.prev, 'genesis')
  assert.equal(second.seq, 2)
  assert.equal(second.prev, first.hash)
  assert.deepEqual(store.verify(), { ok: true, count: 2, lastHash: second.hash, error: null })
  store.close()

  const reopened = new WatchStore({ dir, runId: 'run-a', lockWaitMs: 10 })
  await reopened.open()
  assert.equal(reopened.seq, 2)
  assert.equal(reopened.read().length, 2)
  reopened.close()
})

test('tampering with a committed event fails verification', async () => {
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-b', lockWaitMs: 10 })
  await store.open()
  store.append({ type: 'watch/armed', payload: { mode: 'guard' } })
  store.append({ type: 'watch/case/opened', payload: { caseId: 'case-1' } })
  store.close()

  const file = path.join(dir, 'watch.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  const second = JSON.parse(lines[1])
  second.payload.caseId = 'case-tampered'
  lines[1] = JSON.stringify(second)
  appendFileSync(file, '')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, lines.join('\n'))

  const reopened = new WatchStore({ dir, runId: 'run-b', lockWaitMs: 10 })
  await assert.rejects(() => reopened.open(), /corrupt at line 2/)
})

test('a torn final line is truncated, a corruption before it is not', async () => {
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-c', lockWaitMs: 10 })
  await store.open()
  const first = store.append({ type: 'watch/armed', payload: {} })
  store.close()

  const { writeFileSync } = await import('node:fs')
  const file = path.join(dir, 'watch.jsonl')
  writeFileSync(file, `${JSON.stringify(first)}\n{"v":1,"seq":2`)

  const repaired = new WatchStore({ dir, runId: 'run-c', lockWaitMs: 10 })
  await repaired.open()
  assert.equal(repaired.seq, 1)
  assert.equal(repaired.repaired?.code, 'EJSON')
  assert.equal(repaired.read().length, 1)
  repaired.close()

  const dir2 = tempDir()
  const store2 = new WatchStore({ dir: dir2, runId: 'run-d', lockWaitMs: 10 })
  await store2.open()
  const a = store2.append({ type: 'watch/armed', payload: {} })
  const b = store2.append({ type: 'watch/disarmed', payload: {} })
  store2.close()
  writeFileSync(path.join(dir2, 'watch.jsonl'), `${JSON.stringify(a)}\n{broken}\n${JSON.stringify(b)}\n`)

  const corrupt = new WatchStore({ dir: dir2, runId: 'run-d', lockWaitMs: 10 })
  await assert.rejects(() => corrupt.open(), /corrupt at line 2/)
})

test('payloads are scrubbed before they enter the hash chain', async () => {
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-secret', lockWaitMs: 10 })
  await store.open()
  store.append({
    type: 'watch/restore/result',
    payload: {
      note: 'contact ops@example.com or use sk-abcdefghijklmnopqrstuvwx',
      authorization: 'Bearer abcdefghijklmnop',
      nested: { token: 'secret-token-value', count: 3 },
    },
  })
  const [event] = store.read()
  const text = JSON.stringify(event.payload)
  assert.match(text, /<email>/)
  assert.match(text, /<key>/)
  assert.match(text, /Bearer <redacted>/)
  assert.match(text, /<redacted>/)
  assert.equal(event.payload.nested.count, 3)
  assert.equal(store.verify().ok, true)
  store.close()
})

test('the size cap stops the writer with EWATCHFULL', async () => {
  const dir = tempDir()
  const store = new WatchStore({ dir, runId: 'run-full', maxBytes: 200, lockWaitMs: 10 })
  await store.open()
  store.append({ type: 'watch/armed', payload: { pad: 'x'.repeat(500) } })
  assert.throws(
    () => store.append({ type: 'watch/sample', payload: { pad: 'x'.repeat(500) } }),
    error => error.code === 'EWATCHFULL',
  )
  store.close()
})

test('a second writer is refused while the first holds the lock', async () => {
  const dir = tempDir()
  const first = new WatchStore({ dir, runId: 'run-e', lockWaitMs: 10 })
  await first.open()
  const second = new WatchStore({ dir, runId: 'run-e', lockWaitMs: 10 })
  await assert.rejects(() => second.open(), error => error.code === 'ELOCKED')
  first.close()
  await second.open()
  assert.equal(second.read().length, 0)
  second.close()
})
