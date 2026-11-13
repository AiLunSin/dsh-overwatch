/**
 * Small, dependency-free helpers shared by the Host half.
 *
 * Two of them are load-bearing for the design:
 * - `chainHash` / `canonicalJson` make the watch log tamper-evident.
 * - `FileLock` enforces the single-writer rule for one run directory.
 * @module dsh-overwatch/util
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Hash used before the first watch event. */
export const GENESIS_HASH = 'genesis'

/** @param {string} text @returns {string} */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * Throws on values JSON cannot represent, because silently dropping them
 * would make two different events hash the same.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

/** @param {unknown} value */
function sortValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return value
  }
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const sorted = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue
      sorted[key] = sortValue(source[key])
    }
    return sorted
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
}

/**
 * Chain one event payload onto the previous hash.
 * @param {string} prev previous event hash, or `genesis`
 * @param {unknown} payload event fields that are covered by the hash
 * @returns {string}
 */
export function chainHash(prev, payload) {
  return sha256(`${prev}\n${canonicalJson(payload)}`)
}

/**
 * Where watch state lives. `storage.dataDir` wins; otherwise `$DSH_HOME/overwatch`.
 * @param {{ dataDir?: string }} [storage]
 * @returns {string}
 */
export function resolveDataDir(storage = {}) {
  if (typeof storage.dataDir === 'string' && storage.dataDir.trim() !== '') return path.resolve(storage.dataDir)
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'overwatch')
}

/** @param {string} dir */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/**
 * Write JSON through a same-directory temporary file and an atomic rename.
 * @param {string} file
 * @param {unknown} value
 */
export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * @param {string} file
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return fallback
    throw error
  }
}

/** @param {string} file */
export function fsyncFile(file) {
  const fd = openSync(file, 'a')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @returns {string} */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

/**
 * A Cross-process directory lock. `mkdir` is atomic on every supported
 * filesystem, so exactly one contender wins; a stale owner is detected from
 * its pid (same host) or its age and taken over by an atomic rename.
 */
export class FileLock {
  /**
   * @param {object} options
   * @param {string} options.dir directory holding the lock
   * @param {string} options.name lock name, without extension
   * @param {number} [options.staleMs] take over a lock older than this
   * @param {number} [options.waitMs] how long to wait for the holder
   * @param {number} [options.pollMs]
   * @param {() => number} [options.clock]
   */
  constructor(options) {
    this.dir = options.dir
    this.name = options.name
    this.staleMs = options.staleMs ?? 30_000
    this.waitMs = options.waitMs ?? 0
    this.pollMs = options.pollMs ?? 50
    this.clock = options.clock ?? Date.now
    this.lockPath = path.join(options.dir, `${options.name}.lock`)
    this.ownerPath = path.join(this.lockPath, 'owner.json')
    /** @type {string | null} */
    this.nonce = null
  }

  /**
   * Acquire the lock or throw `ELOCKED`.
   * @returns {Promise<this>}
   */
  async acquire() {
    ensureDir(this.dir)
    const deadline = this.clock() + this.waitMs
    for (;;) {
      if (this.#tryCreate()) return this
      const owner = this.readOwner()
      if (this.#isStale(owner)) {
        this.#breakStale()
        continue
      }
      if (this.clock() >= deadline) {
        const error = new Error(`lock ${this.name} is held by ${describeOwner(owner)}`)
        error.code = 'ELOCKED'
        throw error
      }
      await sleep(this.pollMs)
    }
  }

  /**
   * Synchronous variant for startup paths that cannot await.
   * @returns {this}
   */
  acquireSync() {
    ensureDir(this.dir)
    const deadline = this.clock() + this.waitMs
    for (;;) {
      if (this.#tryCreate()) return this
      const owner = this.readOwner()
      if (this.#isStale(owner)) {
        this.#breakStale()
        continue
      }
      if (this.clock() >= deadline) {
        const error = new Error(`lock ${this.name} is held by ${describeOwner(owner)}`)
        error.code = 'ELOCKED'
        throw error
      }
      const until = this.clock() + this.pollMs
      while (this.clock() < until) {
        // Busy-wait only for the synchronous form; the async form sleeps.
      }
    }
  }

  /** @returns {boolean} */
  #tryCreate() {
    try {
      mkdirSync(this.lockPath)
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return false
      throw error
    }
    const nonce = randomUUID()
    writeFileSync(this.ownerPath, `${JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      nonce,
      acquiredAt: new Date(this.clock()).toISOString(),
    })}\n`, 'utf8')
    this.nonce = nonce
    return true
  }

  /** @returns {Record<string, unknown> | null} */
  readOwner() {
    try {
      return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(this.ownerPath, 'utf8')))
    } catch {
      return null
    }
  }

  /** @param {Record<string, unknown> | null} owner */
  #isStale(owner) {
    let age = this.staleMs + 1
    try {
      age = this.clock() - statSync(this.lockPath).mtimeMs
    } catch {
      return false
    }
    if (owner === null) return age > Math.min(this.staleMs, 2_000)
    if (owner.host === os.hostname() && typeof owner.pid === 'number') {
      try {
        process.kill(owner.pid, 0)
        return false
      } catch (error) {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM') return false
        return true
      }
    }
    return age > this.staleMs
  }

  #breakStale() {
    const aside = `${this.lockPath}.stale-${randomUUID()}`
    try {
      renameSync(this.lockPath, aside)
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return
      throw error
    }
    rmSync(aside, { recursive: true, force: true })
  }

  /** Release only a lock this instance owns. */
  release() {
    if (this.nonce === null) return
    const owner = this.readOwner()
    if (owner !== null && owner.nonce !== this.nonce) {
      this.nonce = null
      throw new Error(`lock ${this.name} is no longer owned by this instance`)
    }
    const aside = `${this.lockPath}.release-${this.nonce}`
    try {
      renameSync(this.lockPath, aside)
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    rmSync(aside, { recursive: true, force: true })
    this.nonce = null
  }

  /** Test helper: remove a lock directory without ownership checks. */
  static forceClear(dir, name) {
    rmSync(path.join(dir, `${name}.lock`), { recursive: true, force: true })
  }
}

/** @param {Record<string, unknown> | null} owner */
function describeOwner(owner) {
  if (owner === null) return 'an unreadable owner'
  return `pid ${String(owner.pid)} on ${String(owner.host)} since ${String(owner.acquiredAt)}`
}

/** @param {string} dir */
export function listDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
