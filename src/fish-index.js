/**
 * Read-only host view of fish-keeper-console data.
 *
 * fishkeeper's Host write surface does not exist (its routes live on the
 * browser-authenticated connection channel), so overwatch only reads the
 * data directory: checkpoint index lines, manifests for accurate pinned/totals,
 * and the tail of each source's action audit. No file content, diary text or
 * blob is ever read here.
 * @module dsh-overwatch/fish-index
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOURCE_ID = /^[A-Za-z0-9._:-]{1,200}$/

/**
 * fishkeeper defaults to `~/.dsh/fishkeeper` (not `$DSH_HOME/fishkeeper`); an
 * explicit `fish.dataDir` wins.
 * @param {{ dataDir?: string }} [fish]
 * @returns {string}
 */
export function resolveFishDataDir(fish = {}) {
  if (typeof fish.dataDir === 'string' && fish.dataDir.trim() !== '') return path.resolve(fish.dataDir)
  return path.join(os.homedir(), '.dsh', 'fishkeeper')
}

/** @param {string} dataDir */
function sourceIdsOf(dataDir) {
  const ids = new Set()
  try {
    for (const entry of readdirSync(path.join(dataDir, 'checkpoints'), { withFileTypes: true })) {
      if (entry.isDirectory() && SOURCE_ID.test(entry.name)) ids.add(entry.name)
    }
  } catch {
    // no checkpoints directory yet
  }
  try {
    for (const entry of readdirSync(path.join(dataDir, 'audit'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.actions.jsonl')) continue
      const id = entry.name.slice(0, -'.actions.jsonl'.length)
      if (SOURCE_ID.test(id)) ids.add(id)
    }
  } catch {
    // no audit directory yet
  }
  return [...ids].sort()
}

/**
 * @param {string} sourceDir
 * @param {number} maxCheckpoints
 * @param {Array<{ code: string, message: string }>} errors
 */
function readCheckpoints(sourceDir, maxCheckpoints, errors) {
  /** @type {Map<string, any>} */
  const byId = new Map()
  const indexPath = path.join(sourceDir, 'index.jsonl')
  if (existsSync(indexPath)) {
    let lines = []
    try {
      lines = readFileSync(indexPath, 'utf8').split('\n')
    } catch (error) {
      errors.push({ code: 'INDEX_UNREADABLE', message: messageOf(error) })
    }
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (typeof record?.id !== 'string' || !/^ck_[A-Za-z0-9_-]{1,120}$/.test(record.id)) continue
        byId.set(record.id, {
          id: record.id,
          createdAt: isoOf(record.createdAt),
          trigger: typeof record.trigger === 'string' ? record.trigger : 'manual',
          files: numberOr(record.files, 0),
          storedBytes: numberOr(record.storedBytes, 0),
          logicalBytes: 0,
          pinned: record.pinned === true,
          baseline: record.trigger === 'baseline',
        })
      } catch {
        errors.push({ code: 'INDEX_LINE_INVALID', message: 'index.jsonl contains a malformed line' })
      }
    }
  }
  // Manifests fill pinned/stored bytes after a pin, and recover sources whose
  // index was rotated away. They are still read-only summaries, not blobs.
  let manifestIds = []
  try {
    manifestIds = readdirSync(sourceDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^ck_/.test(entry.name))
      .map(entry => entry.name)
  } catch {
    manifestIds = []
  }
  for (const id of manifestIds) {
    if (!byId.has(id)) byId.set(id, { id, createdAt: null, trigger: 'manual', files: 0, storedBytes: 0, logicalBytes: 0, pinned: false, baseline: false })
  }
  const sorted = [...byId.values()].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))).slice(0, maxCheckpoints)
  for (const item of sorted.slice(0, 40)) {
    const manifestPath = path.join(sourceDir, item.id, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest?.id !== item.id) continue
      if (Array.isArray(manifest.files)) item.files = manifest.files.length
      if (manifest.totals !== null && typeof manifest.totals === 'object') {
        item.storedBytes = numberOr(manifest.totals.storedBytes, item.storedBytes)
        item.logicalBytes = numberOr(manifest.totals.logicalBytes, 0)
      }
      item.pinned = manifest.pinned === true
      item.baseline = manifest.baseline === true
      if (typeof manifest.trigger?.kind === 'string') item.trigger = manifest.trigger.kind
      item.createdAt = isoOf(manifest.createdAt) ?? item.createdAt
    } catch {
      errors.push({ code: 'MANIFEST_INVALID', message: `manifest for ${item.id} is unreadable` })
    }
  }
  return sorted
}

/**
 * @param {string} file
 * @param {number} max
 * @param {Array<{ code: string, message: string }>} errors
 */
function readAudit(file, max, errors) {
  if (!existsSync(file)) return []
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch (error) {
    errors.push({ code: 'AUDIT_UNREADABLE', message: messageOf(error) })
    return []
  }
  /** @type {any[]} */
  const records = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      records.push({
        at: isoOf(record.at),
        action: typeof record.action === 'string' ? record.action : 'unknown',
        checkpointId: typeof record.checkpointId === 'string' ? record.checkpointId : null,
        result: typeof record.result === 'string' ? record.result : null,
        error: typeof record.error === 'string' ? record.error.slice(0, 300) : null,
        files: Array.isArray(record.files) ? record.files.slice(0, 20).map(String) : null,
      })
    } catch {
      errors.push({ code: 'AUDIT_LINE_INVALID', message: 'an audit line is malformed' })
    }
  }
  return records.slice(-max).reverse()
}

/**
 * @param {{ dataDir: string, maxCheckpoints?: number, maxAudit?: number, sourceId?: string }} input
 */
export function readFishIndex(input) {
  const dataDir = input.dataDir
  const maxCheckpoints = Math.min(Math.max(input.maxCheckpoints ?? 100, 1), 500)
  const maxAudit = Math.min(Math.max(input.maxAudit ?? 50, 1), 200)
  const available = existsSync(dataDir)
  /** @type {Array<{ sourceId: string, checkpoints: any[], audit: any[] }>} */
  const sources = []
  /** @type {Array<{ sourceId: string, code: string, message: string }>} */
  const errors = []
  if (available) {
    for (const sourceId of sourceIdsOf(dataDir)) {
      if (input.sourceId !== undefined && input.sourceId !== sourceId) continue
      const sourceErrors = []
      const checkpoints = readCheckpoints(path.join(dataDir, 'checkpoints', sourceId), maxCheckpoints, sourceErrors)
      const audit = readAudit(path.join(dataDir, 'audit', `${sourceId}.actions.jsonl`), maxAudit, sourceErrors)
      for (const error of sourceErrors) errors.push({ sourceId, ...error })
      sources.push({ sourceId, checkpoints, audit })
    }
  }
  return {
    available,
    dataDir,
    sources,
    errors,
    checkpoints: sources.reduce((sum, source) => sum + source.checkpoints.length, 0),
    asOf: new Date().toISOString(),
  }
}

/** @param {number} value @returns {number} */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** @param {unknown} value @returns {string | null} */
function isoOf(value) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
