/**
 * dsh-overwatch Host entry.
 *
 * M1: arm/disarm supervision of a live dsh-swarm run, sample the three
 * upstreams, open incident cases from deterministic signals, and let the
 * guard pause or abort on budget/log-integrity hard limits. The watch officer
 * agent thread (M2) is deliberately absent: `supervised` arms are rejected, so an
 * installed bundle cannot silently start a model.
 * @module dsh-overwatch
 */

import { readFileSync } from 'node:fs'
import { resolveConfig } from './config.js'
import { createNodeHandler } from './http.js'
import { OverwatchService } from './service.js'
import { registerTools } from './tools.js'

export const name = 'dsh-overwatch'

/** Tools are required; every other capability degrades to `unavailable`. */
export const inject = ['tools']

const VERSION = readVersion()

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * @param {any} ctx Cordis Host context
 * @param {unknown} rawConfig profile config for this row
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.('[overwatch] disabled by config')
    return
  }

  const service = new OverwatchService({
    ctx,
    config,
    version: VERSION,
    logger: ctx.logger,
  })
  await service.open()
  ctx.effect(() => () => service.close())

  // The watch officer's restriction must run in the serial agent/created
  // listener, before the child's first model request. session/event feeds its
  // token ledger.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/created', payload => {
      service.handleAgentCreated(payload?.agent)
    }))
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      service.recordSessionEvent(session, event)
    }))
  }

  if (typeof ctx.tools?.register === 'function') {
    registerTools(ctx, service, config)
  } else {
    ctx.logger?.warn?.('[overwatch] tools service is unavailable; watch_* tools are not registered')
  }

  const webServer = ctx.get?.('webServer')
  let registered = false
  const registerHttp = server => {
    if (registered) return
    if (server === undefined || server === null || typeof server.register !== 'function') return
    try {
      registered = true
      service.attachPorts(typeof server.getOrigin === 'function' ? server.getOrigin() : 'http://127.0.0.1')
      const handler = createNodeHandler({ service, config, version: VERSION })
      ctx.effect(() => server.register({ kind: 'prefix', path: '/overwatch/api', handler }))
    } catch (error) {
      registered = false
      ctx.logger?.warn?.(`[overwatch] HTTP route unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (config.http.enabled) {
    if (webServer !== undefined && webServer !== null) {
      registerHttp(webServer)
    } else {
      // Host services mount asynchronously; the plugin row may run before the
      // web server exists. Register when it appears instead of silently
      // shipping a bundle that answers 404.
      ctx.inject?.(['webServer'], webCtx => registerHttp(webCtx.webServer))
    }
  }

  ctx.logger?.info?.(`[overwatch] active: v${VERSION} mode=${config.mode} dir=${config.dataDir} write=${config.http.token !== ''}`)
}
