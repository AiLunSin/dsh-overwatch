/**
 * Host-side Overwatch service.
 *
 * M0 scope: own the watch log, expose health, and keep the three upstream ports
 * available for the probe. Arm/disarm against a live swarm run, signal
 * sampling, and the watch officer arrive in M1/M2; this class is the seam they
 * will extend, not a stub that pretends they exist.
 * @module dsh-overwatch/service
 */

import { createPorts } from './ports/index.js'
import { WatchStore } from './store.js'
import { resolveDataDir } from './util.js'

export class OverwatchService {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis Host context
   * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
   * @param {string} options.version
   * @param {() => number} [options.clock]
   * @param {{ info?: (msg: string) => void, warn?: (msg: string) => void }} [options.logger]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.version = options.version
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    this.dataDir = resolveDataDir(options.config.storage)
    this.store = new WatchStore({
      dir: this.dataDir,
      runId: 'overwatch',
      clock: this.clock,
      maxBytes: options.config.storage.maxBytesPerRun,
    })
    /** @type {ReturnType<typeof createPorts> | null} */
    this.ports = null
    this.armedAt = null
  }

  /** @returns {string | null} */
  origin() {
    try {
      const webServer = this.ctx.get?.('webServer')
      if (webServer === undefined || webServer === null) return null
      return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
    } catch {
      return null
    }
  }

  async open() {
    await this.store.open()
    if (this.store.repaired !== null) {
      this.store.append({
        type: 'watch/store/repaired',
        actor: 'system',
        payload: { code: this.store.repaired.code, atOffset: this.store.repaired.atOffset },
      })
    }
    const origin = this.origin()
    if (origin !== null) this.attachPorts(origin)
    const event = this.store.append({
      type: 'watch/armed',
      actor: 'system',
      payload: {
        mode: this.config.mode,
        version: this.version,
        capabilities: this.capabilities(),
      },
    })
    this.armedAt = event.at
    this.logger?.info?.(`[overwatch] armed mode=${this.config.mode} dir=${this.dataDir}`)
  }

  /** @param {string} origin */
  attachPorts(origin) {
    this.ports = createPorts({
      origin,
      swarmToken: this.config.http.token,
      timeoutMs: this.config.sampling.requestTimeoutMs,
    })
    return this.ports
  }

  capabilities() {
    return {
      store: true,
      http: this.origin() !== null && this.config.http.enabled,
      supervisor: this.config.mode === 'supervised' && this.config.supervisor.enabled,
      ports: {
        swarm: this.ports !== null,
        pressure: this.ports !== null,
        fish: this.ports !== null,
      },
    }
  }

  async health() {
    const watch = this.store.verify()
    const origin = this.origin()
    if (this.ports === null && origin !== null) this.attachPorts(origin)
    return {
      ok: true,
      version: this.version,
      mode: this.config.mode,
      dataDir: this.dataDir,
      armedAt: this.armedAt,
      watch: { ok: watch.ok, events: watch.count, lastHash: watch.lastHash },
      capabilities: this.capabilities(),
    }
  }

  /**
   * Small read API for the future panel and for M0 evidence.
   * @param {{ since?: number, limit?: number }} [query]
   */
  watchEvents(query = {}) {
    return this.store.read({ since: query.since, limit: Math.min(query.limit ?? 200, 1_000) })
  }

  close() {
    if (this.store.opened) {
      try {
        this.store.append({ type: 'watch/disarmed', actor: 'system', payload: { reason: 'plugin unloaded' } })
        this.store.fsync()
      } catch (error) {
        this.logger?.warn?.(`[overwatch] could not record disarm: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.store.close()
    }
  }
}
