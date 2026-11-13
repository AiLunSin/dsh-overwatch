import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { readFishIndex, resolveFishDataDir } from '../src/fish-index.js'

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overwatch-fish-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = tempDir()
  const source = path.join(root, 'checkpoints', 'fish-a')
  mkdirSync(path.join(source, 'ck_1'), { recursive: true })
  mkdirSync(path.join(source, 'ck_2'), { recursive: true })
  writeFileSync(path.join(source, 'index.jsonl'), [
    JSON.stringify({ schemaVersion: 1, id: 'ck_1', createdAt: '2026-11-14T01:00:00.000Z', trigger: 'baseline', files: 2, storedBytes: 100, pinned: false }),
    JSON.stringify({ schemaVersion: 1, id: 'ck_2', createdAt: '2026-11-14T02:00:00.000Z', trigger: 'diary', files: 3, storedBytes: 200, pinned: false }),
    '{broken',
  ].join('\n') + '\n')
  writeFileSync(path.join(source, 'ck_1', 'manifest.json'), JSON.stringify({
    id: 'ck_1',
    sourceId: 'fish-a',
    createdAt: '2026-11-14T01:00:00.000Z',
    trigger: { kind: 'baseline' },
    baseline: true,
    pinned: false,
    files: [{ path: 'a.md' }, { path: 'b.json' }],
    totals: { storedBytes: 100, logicalBytes: 300 },
  }))
  writeFileSync(path.join(source, 'ck_2', 'manifest.json'), JSON.stringify({
    id: 'ck_2',
    sourceId: 'fish-a',
    createdAt: '2026-11-14T02:00:00.000Z',
    trigger: { kind: 'diary', path: 'a.md' },
    pinned: true,
    files: [{ path: 'a.md' }, { path: 'b.json' }, { path: 'c.txt' }],
    totals: { storedBytes: 220, logicalBytes: 900 },
  }))
  mkdirSync(path.join(root, 'audit'), { recursive: true })
  writeFileSync(path.join(root, 'audit', 'fish-a.actions.jsonl'), [
    JSON.stringify({ schemaVersion: 1, at: '2026-11-14T02:10:00.000Z', action: 'restore', checkpointId: 'ck_2', result: 'ok', files: ['a.md'] }),
    JSON.stringify({ schemaVersion: 1, at: '2026-11-14T02:20:00.000Z', action: 'pin', checkpointId: 'ck_2' }),
    '{bad',
  ].join('\n') + '\n')
  return root
}

test('the host index reads checkpoints, manifests and audit tails without content', () => {
  const root = fixture()
  const index = readFishIndex({ dataDir: root })
  assert.equal(index.available, true)
  assert.equal(index.sources.length, 1)
  const source = index.sources[0]
  assert.equal(source.sourceId, 'fish-a')
  assert.deepEqual(source.checkpoints.map(item => item.id), ['ck_2', 'ck_1'])
  const newest = source.checkpoints[0]
  assert.equal(newest.pinned, true)
  assert.equal(newest.trigger, 'diary')
  assert.equal(newest.files, 3)
  assert.equal(newest.storedBytes, 220)
  assert.equal(newest.logicalBytes, 900)
  assert.equal(source.audit[0].action, 'pin')
  assert.equal(source.audit[1].action, 'restore')
  assert.equal(source.audit[0].result, null)
  // malformed index/audit lines are reported, not thrown
  assert.ok(index.errors.some(error => error.code === 'INDEX_LINE_INVALID'))
  assert.ok(index.errors.some(error => error.code === 'AUDIT_LINE_INVALID'))
})

test('a source filter and a missing data directory are honest', () => {
  const root = fixture()
  const filtered = readFishIndex({ dataDir: root, sourceId: 'fish-a' })
  assert.equal(filtered.sources.length, 1)
  const missing = readFishIndex({ dataDir: root, sourceId: 'fish-z' })
  assert.equal(missing.sources.length, 0)
  const absent = readFishIndex({ dataDir: path.join(root, 'does-not-exist') })
  assert.equal(absent.available, false)
  assert.deepEqual(absent.sources, [])
})

test('fish data dir defaults to the fishkeeper home and honors an override', () => {
  const dir = tempDir()
  assert.equal(resolveFishDataDir({ dataDir: dir }), path.resolve(dir))
  assert.match(resolveFishDataDir({}), /[\\/]\.dsh[\\/]fishkeeper$/)
})
