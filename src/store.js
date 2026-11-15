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
import { FileLock, GENESIS_HASH, assertNotSymlink, canonicalJson, chainHash, chainKeyFromEnv, ensureDir, newId, scrub, sha256 } from './util.js'

/** @typedef {{ v: 1, seq: number, id: string, runId: string, type: string, at: string, actor: string, generation: number, causationRef: unknown, payload: unknown, prev: string, hash: string, alg?: 'hmac-sha256' }} WatchEvent */

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
   * @param {string} [options.hmacKey] HMAC key for chain links; defaults to OVERWATCH_CHAIN_KEY
   * @param {string} [options.anchorFile] optional external anchor file for the chain head
   * @param {number} [options.anchorEvery] append an anchor after this many events
   */
  constructor(options) {
    this.dir = options.dir
    this.runId = options.runId ?? 'overwatch'
    this.clock = options.clock ?? Date.now
    this.maxBytes = options.maxBytes ?? 52_428_800
    this.repair = options.repair ?? true
    this.hmacKey = options.hmacKey ?? chainKeyFromEnv()
    this.anchorFile = options.anchorFile ?? ''
    this.anchorEvery = options.anchorEvery ?? 64
    this.appendedSinceAnchor = 0
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
    assertNotSymlink(this.file)
    const raw = readFileSync(this.file, 'utf8')
    if (raw === '') return
    const parsed = parseChain(raw, this.runId, { hmacKey: this.hmacKey })
    if (parsed.error !== null) {
      // Repair only when the damaged record is the last physical line and the
      // file ended without a newline, i.e. a torn append. A corruption before
      // the tail must fail loudly; never truncate committed evidence, and never
      // truncate to zero just because the first record is unreadable.
      const physicalLines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
      const isTornTail = parsed.error.line === physicalLines && !raw.endsWith('\n')
      if (this.repair && isTornTail && parsed.events.length > 0) {
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
    // A crash can also leave a complete final JSON line without its newline.
    // Restore the separator before the next append so two events cannot merge.
    if (!raw.endsWith('\n')) appendFileSync(this.file, '\n', { encoding: 'utf8', mode: 0o600 })
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
    assertNotSymlink(this.file)
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
      payload: scrub(input.payload ?? null),
      prev: this.prev,
      ...(this.hmacKey === '' ? {} : { alg: /** @type {const} */ ('hmac-sha256') }),
    }
    const hash = chainHash(this.prev, body, this.hmacKey)
    const event = /** @type {WatchEvent} */ ({ ...body, hash })
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.seq = seq
    this.prev = hash
    this.lastAt = at
    this.appendedSinceAnchor += 1
    if (this.anchorFile !== '' && this.appendedSinceAnchor >= this.anchorEvery) this.writeAnchor()
    return event
  }

  /**
   * Record the verified chain head in a separate file, so truncating or
   * rewriting the run log is detectable even when the run directory is writable.
   * @returns {{ runId: string, seq: number, hash: string, at: string } | null}
   */
  writeAnchor() {
    if (this.anchorFile === '' || this.seq === 0) return null
    const anchor = { runId: this.runId, seq: this.seq, hash: this.prev, at: new Date(this.clock()).toISOString() }
    ensureDir(path.dirname(this.anchorFile))
    appendFileSync(this.anchorFile, `${JSON.stringify(anchor)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.appendedSinceAnchor = 0
    return anchor
  }

  /**
   * Re-read the whole file and verify the chain.
   * @returns {{ ok: boolean, count: number, lastHash: string | null, error: string | null }}
   */
  verify() {
    if (!existsSync(this.file)) return { ok: true, count: 0, lastHash: null, error: null }
    const parsed = parseChain(readFileSync(this.file, 'utf8'), this.runId, { hmacKey: this.hmacKey })
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
    const parsed = parseChain(readFileSync(this.file, 'utf8'), this.runId, { hmacKey: this.hmacKey })
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
    try {
      this.writeAnchor()
    } finally {
      this.opened = false
      this.lock.release()
    }
  }
}

/**
 * Parse and verify a whole log. Returns the valid prefix and the first error.
 * @param {string} raw
 * @param {string} runId
 * @param {{ hmacKey?: string }} [options]
 * @returns {{ events: WatchEvent[], validBytes: number, error: { line: number, code: string, message: string } | null }}
 */
export function parseChain(raw, runId, options = {}) {
  const hmacKey = options.hmacKey ?? ''
  /** @type {WatchEvent[]} */
  const events = []
  let offset = 0
  let prev = GENESIS_HASH
  let seq = 0
  let lineNo = 0
  let hmacSeen = false
  while (offset < raw.length) {
    lineNo += 1
    const newline = raw.indexOf('\n', offset)
    const end = newline === -1 ? raw.length : newline
    const line = raw.slice(offset, end)
    const nextOffset = newline === -1 ? raw.length : newline + 1
    if (line.trim() === '') {
      offset = nextOffset
      continue
    }
    const validBytes = Buffer.byteLength(raw.slice(0, offset), 'utf8')
    /** @type {WatchEvent} */
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return { events, validBytes, error: { line: lineNo, code: 'EJSON', message: 'line is not valid JSON' } }
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return { events, validBytes, error: { line: lineNo, code: 'ESCHEMA', message: 'line is not a JSON object' } }
    }
    if (event.v !== 1) {
      return { events, validBytes, error: { line: lineNo, code: 'EVERSION', message: `unsupported version ${String(event.v)}` } }
    }
    if (event.runId !== runId) {
      return { events, validBytes, error: { line: lineNo, code: 'ERUN', message: `runId ${String(event.runId)} does not match ${runId}` } }
    }
    if (event.seq !== seq + 1) {
      return { events, validBytes, error: { line: lineNo, code: 'ESEQ', message: `expected seq ${seq + 1}, got ${String(event.seq)}` } }
    }
    if (event.prev !== prev) {
      return { events, validBytes, error: { line: lineNo, code: 'EPREV', message: 'previous hash does not match' } }
    }
    const isHmac = event.alg === 'hmac-sha256'
    if (event.alg !== undefined && !isHmac) {
      return { events, validBytes, error: { line: lineNo, code: 'EALG', message: `unsupported hash algorithm ${String(event.alg)}` } }
    }
    // Once a log switches to HMAC it must never silently downgrade again: a
    // plain link after a signed one would let an attacker strip signatures.
    if (hmacSeen && !isHmac) {
      return { events, validBytes, error: { line: lineNo, code: 'EALG', message: 'HMAC chain was downgraded to a plain hash' } }
    }
    if (isHmac && hmacKey === '') {
      return { events, validBytes, error: { line: lineNo, code: 'EHMACKEY', message: 'event is HMAC-signed but OVERWATCH_CHAIN_KEY is not set' } }
    }
    const { hash, ...body } = event
    const expected = chainHash(prev, body, isHmac ? hmacKey : '')
    if (hash !== expected) {
      return { events, validBytes, error: { line: lineNo, code: 'EHASH', message: 'event hash does not match' } }
    }
    if (isHmac) hmacSeen = true
    events.push(event)
    prev = hash
    seq = event.seq
    offset = nextOffset
  }
  return { events, validBytes: Buffer.byteLength(raw, 'utf8'), error: null }
}

/** Canonical fingerprint of an event's hashed body. @param {WatchEvent} event */
export function eventFingerprint(event) {
  const { hash: _hash, ...body } = event
  return sha256(canonicalJson(body))
}

/**
 * Read and verify a run log without taking the writer lock. The panel and the
 * service registry use this for runs this process does not supervise (history,
 * or a run held by another Host). A corrupt chain is returned as data, not
 * thrown: the read API must be able to describe the damage.
 * @param {string} dir run directory
 * @param {string} runId
 * @param {{ hmacKey?: string }} [options]
 * @returns {{ events: WatchEvent[], chain: { ok: boolean, count: number, lastHash: string | null, error: string | null } }}
 */
export function readWatchLog(dir, runId, options = {}) {
  const file = path.join(dir, 'watch.jsonl')
  if (!existsSync(file)) return { events: [], chain: { ok: true, count: 0, lastHash: null, error: null } }
  const parsed = parseChain(readFileSync(file, 'utf8'), runId, options)
  const chain = parsed.error === null
    ? { ok: true, count: parsed.events.length, lastHash: parsed.events.at(-1)?.hash ?? null, error: null }
    : {
        ok: false,
        count: parsed.events.length,
        lastHash: parsed.events.at(-1)?.hash ?? null,
        error: `${parsed.error.code} at line ${parsed.error.line}: ${parsed.error.message}`,
      }
  return { events: parsed.events, chain }
}

/**
 * Read the external anchor file. A torn final line is ignored because anchors
 * are written independently of the chain and may be cut short by a crash.
 * @param {string} file
 * @returns {{ anchors: Array<{ runId: string, seq: number, hash: string, at: string }>, error: string | null }}
 */
export function readAnchors(file) {
  if (file === '' || !existsSync(file)) return { anchors: [], error: null }
  const lines = readFileSync(file, 'utf8').split('\n')
  const anchors = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string' || typeof parsed.runId !== 'string') {
        return { anchors, error: `anchor line ${index + 1} is malformed` }
      }
      anchors.push(parsed)
    } catch {
      if (index === lines.length - 1) continue
      return { anchors, error: `anchor line ${index + 1} is not valid JSON` }
    }
  }
  return { anchors, error: null }
}

/**
 * Check the latest external anchor against verified log events. This detects a
 * tail truncation or a full rewrite that kept a valid internal chain.
 * @param {string} file
 * @param {WatchEvent[]} events
 * @param {string} runId
 * @returns {{ ok: boolean, count: number, last: { seq: number, hash: string } | null, error: string | null }}
 */
export function verifyAnchor(file, events, runId) {
  const read = readAnchors(file)
  if (read.error !== null) return { ok: false, count: read.anchors.length, last: null, error: read.error }
  const ours = read.anchors.filter(anchor => anchor.runId === runId)
  if (ours.length === 0) return { ok: true, count: 0, last: null, error: null }
  const latest = ours.at(-1)
  const match = events.find(event => event.seq === latest.seq)
  if (match === undefined) {
    return {
      ok: false,
      count: ours.length,
      last: { seq: latest.seq, hash: latest.hash },
      error: `anchor points at seq ${latest.seq} but the verified log ends at seq ${events.at(-1)?.seq ?? 0}`,
    }
  }
  if (match.hash !== latest.hash) {
    return { ok: false, count: ours.length, last: { seq: latest.seq, hash: latest.hash }, error: `anchor hash does not match event ${latest.seq}` }
  }
  return { ok: true, count: ours.length, last: { seq: latest.seq, hash: latest.hash }, error: null }
}
