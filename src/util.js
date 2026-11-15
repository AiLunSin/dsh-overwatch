/**
 * Small, dependency-free helpers shared by the Host half.
 *
 * Two of them are load-bearing for the design:
 * - `chainHash` / `canonicalJson` make the watch log tamper-evident.
 * - `FileLock` enforces the single-writer rule for one run directory.
 * @module dsh-overwatch/util
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
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
 * Chain one event payload onto the previous hash. With a key the link is an
 * HMAC-SHA256, so an attacker who can rewrite the file still cannot forge a
 * valid tail without the key.
 * @param {string} prev previous event hash, or `genesis`
 * @param {unknown} payload event fields that are covered by the hash
 * @param {string} [key] optional HMAC key
 * @returns {string}
 */
export function chainHash(prev, payload, key = '') {
  const text = `${prev}\n${canonicalJson(payload)}`
  if (key !== '') return createHmac('sha256', key).update(text, 'utf8').digest('hex')
  return sha256(text)
}

/** The optional chain HMAC key, read from the process environment. */
export function chainKeyFromEnv(env = process.env) {
  const configured = env.OVERWATCH_CHAIN_KEY
  return typeof configured === 'string' ? configured.trim() : ''
}

/** True when `file` exists and is a symlink (never followed). */
export function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Symlinks would let a run directory point the writer at an attacker-chosen
 * file, so the watch log refuses to open through one.
 * @param {string} file
 */
export function assertNotSymlink(file) {
  if (isSymlink(file)) {
    const error = new Error(`${file} is a symlink; refusing to write through it`)
    error.code = 'ESYMLINK'
    throw error
  }
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
  // Owner-only on POSIX; Windows ignores the mode bits.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * Write JSON through a same-directory temporary file and an atomic rename.
 * On Windows a concurrent reader (the panel, a doctor poll, an indexer) can make
 * `rename` fail with EPERM/EBUSY; retry briefly, then fall back to a direct write
 * so a status file cannot wedge supervision.
 * @param {string} file
 * @param {unknown} value
 */
export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 7) {
        try {
          writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
        } catch {
          // The caller records the failure; the lock still protects the log.
        }
        try {
          rmSync(tmp, { force: true })
        } catch {
          // best effort
        }
        return
      }
      const end = Date.now() + 20
      while (Date.now() < end) { /* short synchronous backoff */ }
    }
  }
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
        this.#breakStale(owner)
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
        this.#breakStale(owner)
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
    if (isSymlink(this.lockPath)) {
      const error = new Error(`lock ${this.name} is a symlink; refusing to use it`)
      error.code = 'ELOCKSYMLINK'
      throw error
    }
    try {
      mkdirSync(this.lockPath, { mode: 0o700 })
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
    })}\n`, { encoding: 'utf8', mode: 0o600 })
    this.nonce = nonce
    return true
  }

  /** @returns {Record<string, unknown> | null} */
  readOwner() {
    return readOwnerFile(this.ownerPath)
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

  /**
   * Take over a stale lock without TOCTOU: after the atomic rename, re-read the
   * owner that actually moved. If another contender acquired a fresh lock
   * between our stale check and the rename, put it back instead of deleting a
   * live holder.
   * @param {Record<string, unknown> | null} examined
   */
  #breakStale(examined) {
    const aside = `${this.lockPath}.stale-${randomUUID()}`
    try {
      renameSync(this.lockPath, aside)
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return
      throw error
    }
    const moved = readOwnerFile(path.join(aside, 'owner.json'))
    const examinedNonce = typeof examined?.nonce === 'string' ? examined.nonce : ''
    const movedNonce = typeof moved?.nonce === 'string' ? moved.nonce : ''
    if (examinedNonce !== '' && movedNonce !== '' && examinedNonce !== movedNonce) {
      // We raced a fresh owner. Restore it if the name is still free; otherwise a
      // third contender already won and this aside copy is stale.
      try {
        renameSync(aside, this.lockPath)
      } catch {
        rmSync(aside, { recursive: true, force: true })
      }
      return
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

/** Read a lock owner without following a symlink. @param {string} file */
function readOwnerFile(file) {
  try {
    if (isSymlink(file)) return null
    return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
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

/** @param {number} value @param {number} min @param {number} max @returns {number} */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** @param {number} part @param {number} whole @returns {number} 0 when the whole is not positive */
export function ratio(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.max(0, part) / whole
}

/**
 * Mask the few secret shapes that can plausibly reach a watch payload. Prose is
 * never stored verbatim anywhere else, so this is a last line of defence, not a
 * general DLP engine.
 * @param {string} text
 * @returns {string}
 */
export function scrubText(text) {
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<key>')
    .replace(/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b/g, '<key>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<key>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(/\b(?:token|api[_-]?key|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, '<redacted>')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '<phone>')
}

/**
 * Deep-scrub a JSON-like value and bound its size. Values that JSON cannot carry
 * are dropped explicitly instead of becoming `undefined` inside the log.
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
export function scrub(value, maxBytes = 16_384) {
  const clean = scrubValue(value, 0)
  let text
  try {
    text = JSON.stringify(clean)
  } catch {
    return { truncated: true, reason: 'unserializable' }
  }
  if (text.length > maxBytes) return { truncated: true, bytes: text.length }
  return clean
}

/** @param {unknown} value @param {number} depth @returns {unknown} */
function scrubValue(value, depth) {
  if (depth > 8) return '<depth>'
  if (typeof value === 'string') return scrubText(value).slice(0, 4_096)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => scrubValue(item, depth + 1))
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      out[scrubText(key)] = scrubValue(child, depth + 1)
    }
    return out
  }
  return undefined
}
