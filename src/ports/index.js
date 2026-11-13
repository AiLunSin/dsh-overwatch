/**
 * Port bundle for the local Host web server. All three upstreams share one
 * origin; the caller decides which features are enabled.
 * @module dsh-overwatch/ports
 */

import { FishPort } from './fish.js'
import { PressurePort } from './pressure.js'
import { SwarmPort } from './swarm.js'

/**
 * @param {object} options
 * @param {string} options.origin
 * @param {string} [options.swarmToken]
 * @param {number} [options.timeoutMs]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 */
export function createPorts(options) {
  return {
    swarm: new SwarmPort({ ...options, token: options.swarmToken }),
    pressure: new PressurePort(options),
    fish: new FishPort(options),
  }
}

export { FishPort, PressurePort, SwarmPort }
