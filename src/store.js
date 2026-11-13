/**
 * The single-writer watch log.
 *
 * One `watch.jsonl` per run, one writer (enforced by `FileLock`), one hash
 * chain. The log records judgments and actions, never upstream payloads. On
 * open, a torn final line left by a crash is truncated back to the last
 * complete event; a corruption before the tail fails loudly instead of
 * discarding committed evidence.
 * @module dsh-overwatch/store
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, truncateSync } from 'node:fs'
import path from 'node:path'
import { FileLock, GENESIS_HASH, canonicalJson, chainHash, ensureDir, newId, sha256 } from './util.js'

/** @typedef {{ v: 1, seq: number, id: string, runId: string, type: string, at: string, actor: string, generation: number, causationRef: unknown, payload: unknown, prev: string, hash: string }} WatchEvent */

export class WatchStoreError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'WatchStoreError'
    this.code = code
  }
}

export class WatchStore {
  /**
   * @param {object} options
   * @param {string} options.dir run directory
   * @param {string} [options.runId]
   * @param {() => number} [options.clock]
   * @param {number} [options.lockWaitMs]
   * @param {number} [options.lockStaleMs]
   * @param {number} [options.maxBytes]
   * @param {boolean} [options.repair]
   */
  constructor(options) {
    this.dir = options.dir
    this.runId = options.runId ?? 'overwatch'
    this.clock = options.clock ?? Date.now
    this.maxBytes = options.maxBytes ?? 52_428_800
    this.repair = options.repair ?? true
    this.file = path.join(this.dir, 'watch.jsonl')
    this.lock = new FileLock({
      dir: this.dir,
      name: `watch-${this.runId}`,
      staleMs: options.lockStaleMs,
      waitMs: options.lockWaitMs ?? 2_000,
      clock: this.clock,
    })
    this.opened = false
    this.seq = 0
    this.prev = GENESIS_HASH
    /** @type {WatchEvent['at'] | null} */
    this.lastAt = null
    /** @type {{ code: string, atOffset: number } | null} */
    this.repaired = null
    /** @type {unknown[]} */
    this.warnings = []
  }

  /** Acquire the writer lock and validate/repair the log. */
  async open() {
    ensureDir(this.dir)
    await this.lock.acquire()
    try {
      this.#load()
      this.opened = true
    } catch (error) {
      this.lock.release()
      throw error
    }
  }

  /** Synchronous open for tests and startup paths. */
  openSync() {
    ensureDir(this.dir)
    this.lock.acquireSync()
    try {
      this.#load()
      this.opened = true
    } catch (error) {
      this.lock.release()
      throw error
    }
  }

  #load() {
    if (!existsSync(this.file)) {
      this.seq = 0
      this.prev = GENESIS_HASH
      return
    }
    const raw = readFileSync(this.file, 'utf8')
    if (raw === '') return
    const parsed = parseChain(raw, this.runId)
    if (parsed.error !== null) {
      const finalLine = parsed.events.length + 1
      if (this.repair && parsed.error.line === finalLine && !raw.endsWith('\n')) {
        truncateSync(this.file, parsed.validBytes)
        this.repaired = { code: parsed.error.code, atOffset: parsed.validBytes }
      } else {
        throw new WatchStoreError(
          `watch log is corrupt at line ${parsed.error.line}: ${parsed.error.message}`,
          'EWATCHCORRUPT',
        )
      }
    }
    const last = parsed.events.at(-1)
    if (last !== undefined) {
      this.seq = last.seq
      this.prev = last.hash
      this.lastAt = last.at
    }
    this.#checkSize()
  }

  #checkSize() {
    if (!existsSync(this.file)) return
    const size = statSync(this.file).size
    if (size > this.maxBytes) throw new WatchStoreError(`watch log exceeds ${this.maxBytes} bytes`, 'EWATCHFULL')
  }

  /**
   * Append one event. The returned event is already durable before return.
   * @param {object} input
   * @param {string} input.type
   * @param {unknown} [input.payload]
   * @param {string} [input.actor]
   * @param {unknown} [input.causationRef]
   * @param {number} [input.generation]
   * @returns {WatchEvent}
   */
  append(input) {
    if (!this.opened) throw new WatchStoreError('watch store is not open', 'ECLOSED')
    this.#checkSize()
    const seq = this.seq + 1
    const at = new Date(this.clock()).toISOString()
    /** @type {Omit<WatchEvent, 'hash'>} */
    const body = {
      v: 1,
      seq,
      id: newId('wev'),
      runId: this.runId,
      type: input.type,
      at,
      actor: input.actor ?? 'system',
      generation: input.generation ?? 1,
      causationRef: input.causationRef ?? null,
      payload: input.payload ?? null,
      prev: this.prev,
    }
    const hash = chainHash(this.prev, body)
    const event = /** @type {WatchEvent} */ ({ ...body, hash })
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    this.seq = seq
    this.prev = hash
    this.lastAt = at
    return event
  }

  /**
   * Re-read the whole file and verify the chain.
   * @returns {{ ok: boolean, count: number, lastHash: string | null, error: string | null }}
   */
  verify() {
    if (!existsSync(this.file)) return { ok: true, count: 0, lastHash: null, error: null }
    const parsed = parseChain(readFileSync(this.file, 'utf8'), this.runId)
    if (parsed.error !== null) {
      return { ok: false, count: parsed.events.length, lastHash: parsed.events.at(-1)?.hash ?? null, error: `${parsed.error.code} at line ${parsed.error.line}: ${parsed.error.message}` }
    }
    return { ok: true, count: parsed.events.length, lastHash: parsed.events.at(-1)?.hash ?? null, error: null }
  }

  /**
   * Read committed events, oldest first.
   * @param {{ since?: number, limit?: number }} [query]
   * @returns {WatchEvent[]}
   */
  read(query = {}) {
    if (!existsSync(this.file)) return []
    const parsed = parseChain(readFileSync(this.file, 'utf8'), this.runId)
    if (parsed.error !== null) throw new WatchStoreError(parsed.error.message, 'EWATCHCORRUPT')
    const since = query.since ?? 0
    const limit = query.limit ?? Number.MAX_SAFE_INTEGER
    return parsed.events.filter(event => event.seq > since).slice(0, limit)
  }

  /** Flush the file to disk. */
  fsync() {
    if (!existsSync(this.file)) return
    const fd = openSync(this.file, 'a')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  close() {
    if (!this.opened) return
    this.opened = false
    this.lock.release()
  }
}

/**
 * Parse and verify a whole log. Returns the valid prefix and the first error.
 * @param {string} raw
 * @param {string} runId
 * @returns {{ events: WatchEvent[], validBytes: number, error: { line: number, code: string, message: string } | null }}
 */
export function parseChain(raw, runId) {
  /** @type {WatchEvent[]} */
  const events = []
  let offset = 0
  let prev = GENESIS_HASH
  let seq = 0
  while (offset < raw.length) {
    const newline = raw.indexOf('\n', offset)
    const end = newline === -1 ? raw.length : newline
    const line = raw.slice(offset, end)
    const nextOffset = newline === -1 ? raw.length : newline + 1
    if (line.trim() === '') {
      offset = nextOffset
      continue
    }
    /** @type {WatchEvent} */
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'EJSON', message: 'line is not valid JSON' } }
    }
    if (event.v !== 1) {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'EVERSION', message: `unsupported version ${String(event.v)}` } }
    }
    if (event.runId !== runId) {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'ERUN', message: `runId ${String(event.runId)} does not match ${runId}` } }
    }
    if (event.seq !== seq + 1) {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'ESEQ', message: `expected seq ${seq + 1}, got ${String(event.seq)}` } }
    }
    if (event.prev !== prev) {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'EPREV', message: 'previous hash does not match' } }
    }
    const { hash, ...body } = event
    const expected = chainHash(prev, body)
    if (hash !== expected) {
      return { events, validBytes: offset, error: { line: events.length + 1, code: 'EHASH', message: 'event hash does not match' } }
    }
    events.push(event)
    prev = hash
    seq = event.seq
    offset = nextOffset
  }
  return { events, validBytes: offset, error: null }
}

/** Canonical fingerprint of an event's hashed body. @param {WatchEvent} event */
export function eventFingerprint(event) {
  const { hash: _hash, ...body } = event
  return sha256(canonicalJson(body))
}
