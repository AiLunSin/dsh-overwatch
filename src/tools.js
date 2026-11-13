/**
 * Agent-facing tools.
 *
 * Only the root agent may arm or disarm supervision. Worker subagents inherit
 * global tools in DSH, so the `when` predicate is the first line of defence; the
 * handler repeats the check because a tool result must not depend on a single
 * seam.
 * @module dsh-overwatch/tools
 */

/** @param {any} exec */
function isSubagent(exec) {
  return exec?.agent?.session?.header?.origin === 'subagent'
}

/** @param {unknown} error */
function failure(error) {
  return {
    ok: false,
    code: typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** @param {unknown} value */
function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * @param {any} ctx Cordis Host context
 * @param {import('./service.js').OverwatchService} service
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config
 */
export function registerTools(ctx, service, config) {
  const rootOnly = {
    when: ({ agent }) => agent?.session?.header?.origin !== 'subagent',
  }

  ctx.tools.register({
    name: 'watch_arm',
    description: 'Start deterministic supervision (hard budget log integrity guard) of a live dsh-swarm run. M1 is guard-only: it never starts a watch officer. Requires the root agent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', description: 'Swarm run id, [A-Za-z0-9_-]{1,200}.' },
        mode: { type: 'string', enum: ['observe', 'guard', 'supervised'], description: 'Defaults to the profile mode. supervised is unavailable in M1.' },
      },
      required: ['runId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return renderJson(value)
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      try {
        if (isSubagent(exec)) return { ok: false, code: 'ROOT_ONLY', message: 'only the root agent may arm supervision' }
        if (args?.mode === 'supervised') {
          // Service/RunSupervisor still enforce the real preconditions; this only
          // gives the model a clearer error before any upstream call.
          if (!exec?.agent) return { ok: false, code: 'AGENT_REQUIRED', message: 'supervised arm needs the root agent as parent' }
        }
        const result = await service.arm({
          runId: String(args?.runId ?? ''),
          mode: args?.mode,
          parentAgent: exec?.agent,
          agentId: exec?.agent?.id === undefined ? undefined : String(exec.agent.id),
        })
        return { ok: true, ...result }
      } catch (error) {
        return failure(error)
      }
    },
  }, rootOnly)

  ctx.tools.register({
    name: 'watch_disarm',
    description: 'Stop supervision of a run, abandon its open cases, and close its watch log writer. Requires the root agent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string' },
        reason: { type: 'string', description: 'Short reason recorded in the watch log.' },
      },
      required: ['runId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return renderJson(value)
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      try {
        if (isSubagent(exec)) return { ok: false, code: 'ROOT_ONLY', message: 'only the root agent may disarm supervision' }
        const result = await service.disarm(String(args?.runId ?? ''), typeof args?.reason === 'string' ? args.reason : 'disarmed by the root agent')
        return { ok: true, ...result }
      } catch (error) {
        return failure(error)
      }
    },
  }, rootOnly)

  ctx.tools.register({
    name: 'watch_status',
    description: 'Read the in-memory supervision state: runs, mode, freshness, budget, open cases. Never calls an upstream.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', description: 'Omit to list every known run.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return renderJson(value)
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe() {
      return true
    },
    async execute(args) {
      try {
        if (typeof args?.runId === 'string' && args.runId !== '') {
          const view = service.getRun(args.runId)
          if (view === null) return { ok: false, code: 'RUN_NOT_FOUND', message: `run ${args.runId} not found` }
          return { ok: true, data: view }
        }
        return { ok: true, health: service.health(), runs: service.listRuns() }
      } catch (error) {
        return failure(error)
      }
    },
  }, rootOnly)

  ctx.tools.register({
    name: 'watch_report',
    description: 'Render the Markdown incident report for one supervised run (budget, cases, actions, chain state).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string' },
        format: { type: 'string', enum: ['md', 'json'], description: 'Defaults to md.' },
      },
      required: ['runId'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return renderJson(value)
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe() {
      return true
    },
    async execute(args) {
      try {
        const runId = String(args?.runId ?? '')
        const format = args?.format === 'json' ? 'json' : 'md'
        const report = service.report(runId)
        if (format === 'json') {
          return { ok: true, runId, format, data: { cases: service.cases(runId, { state: 'all', limit: 100 }), report } }
        }
        return { ok: true, runId, format, report }
      } catch (error) {
        return failure(error)
      }
    },
  }, rootOnly)

  return {
    names: ['watch_arm', 'watch_disarm', 'watch_status', 'watch_report'],
    mode: config.mode,
  }
}
