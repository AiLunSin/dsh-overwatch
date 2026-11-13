/**
 * dsh-overwatch Host entry.
 *
 * M0: owns the run's watch log and exposes a loopback read API. It does not yet
 * arm a swarm, sample signals, or start the watch officer — those are M1/M2 and
 * deliberately absent so an installed bundle cannot silently act.
 * @module dsh-overwatch
 */

import { readFileSync } from 'node:fs'
import { resolveConfig } from './config.js'
import { createNodeHandler } from './http.js'
import { OverwatchService } from './service.js'

export const name = 'dsh-overwatch'

/** No hard dependency: every capability degrades to `unavailable`. */
export const inject = []

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

  const webServer = ctx.get?.('webServer')
  const registerHttp = server => {
    if (server === undefined || server === null || typeof server.register !== 'function') return
    try {
      service.attachPorts(server.getOrigin())
      const handler = createNodeHandler({ service, config, version: VERSION })
      ctx.effect(() => server.register({ kind: 'prefix', path: '/overwatch/api', handler }))
    } catch (error) {
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

  ctx.logger?.info?.(`[overwatch] active: v${VERSION} mode=${config.mode} dir=${config.dataDir}`)
}
