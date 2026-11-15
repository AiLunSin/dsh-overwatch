/**
 * Scripted root provider for the A/B/C supervision comparison.
 *
 * The root is deliberately fake: it arms the run as `supervised`, waits until
 * the runner drops the completion file, then disarms. The watch child is routed
 * to the real `deepseek-account` provider by `supervisor.agentOptions`, so the
 * only model spend in group C is the watch wake itself.
 *
 * A small fake watch persona is kept for offline smoke runs
 * (`OVERWATCH_ABC_WATCH=fake`); it is never used by the real C runs.
 * @module dsh-fake-llm-abc
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const name = 'fake-llm-abc'
export const inject = ['llm']

const LOG = process.env.OVERWATCH_ABC_LLM_LOG ?? ''
const RUN_ID = process.env.OVERWATCH_ABC_RUN_ID ?? ''
const DONE = process.env.OVERWATCH_ABC_DONE ?? ''
const WATCH_MODE = process.env.OVERWATCH_ABC_WATCH ?? 'real'
const DONE_TIMEOUT_MS = 240_000

/** @type {Map<string, number>} */
const callsBySession = new Map()
/** @type {Map<string, { caseId: string | null, evidenceId: string | null }>} */
const factsBySession = new Map()

/** @param {string} provider @param {string} model */
function createAdapter(provider, model) {
  return {
    providerInfo() {
      return { id: provider, name: 'Fake root provider (ABC)' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    async listModels() {
      return [{ provider, id: model, name: 'Fake root model' }]
    },
    async resolveModel() {
      return {
        provider,
        id: model,
        name: 'Fake root model',
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 4_096,
      }
    },
    async prepareCall() {
      return { model: await this.resolveModel(), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const tools = Array.isArray(options?.tools) ? options.tools : []
      const toolNames = tools.map(tool => String(tool.name ?? ''))
      const sessionId = String(options?.sessionId ?? 'unknown')
      if (tools.length === 0) {
        yield usage(0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const call = (callsBySession.get(sessionId) ?? 0) + 1
      callsBySession.set(sessionId, call)
      const hasToolResult = Array.isArray(options?.messages) && options.messages.some(message => message?.role === 'tool')
      logRequest({ sessionId, call, toolNames, hasToolResult, at: new Date().toISOString() })

      if (toolNames.includes('watch_arm')) {
        yield* rootPersona({ sessionId, call, hasToolResult })
        return
      }
      if (toolNames.includes('watch_decide') && WATCH_MODE === 'fake') {
        yield* fakeWatchPersona({ sessionId, call, hasToolResult, text: allUserText(options?.messages) })
        return
      }
      yield* textReply('fake-llm-abc: no persona for this tool table')
      yield usage(call)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * Root: arm supervised, hold until the runner writes the done file, disarm.
 * @param {{ sessionId: string, call: number, hasToolResult: boolean }} input
 */
async function* rootPersona(input) {
  const { sessionId, call, hasToolResult } = input
  if (!hasToolResult) {
    yield* toolCall('watch_arm', { runId: RUN_ID, mode: 'supervised' }, sessionId, call)
    yield usage(call, 1_800)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 2) {
    yield usage(call, 800)
    await waitForDone()
    yield* toolCall('watch_disarm', { runId: RUN_ID, reason: 'A/B/C run complete' }, sessionId, call)
    yield usage(call, 800)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  yield* textReply('ABC root done')
  yield usage(call, 500)
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Offline fake watch persona, used only when `OVERWATCH_ABC_WATCH=fake`.
 * @param {{ sessionId: string, call: number, hasToolResult: boolean, text: string }} input
 */
function* fakeWatchPersona(input) {
  const { sessionId, call, hasToolResult, text } = input
  let facts = factsBySession.get(sessionId)
  if (facts === undefined) {
    facts = {
      caseId: matchGroup(text, /"caseId"\s*:\s*"(case_[A-Za-z0-9_-]+)"/),
      evidenceId: matchGroup(text, /"evidenceIds"\s*:\s*\[\s*"([^"]+)"/),
    }
    factsBySession.set(sessionId, facts)
  }
  if (facts.caseId === null) {
    yield* textReply('ABC fake watch: case card missing a caseId')
    yield usage(call, 1_500)
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  if (!hasToolResult) {
    yield* toolCall('watch_case', {}, sessionId, call)
    yield usage(call, 3_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 2) {
    yield* toolCall('watch_evidence', {
      caseId: facts.caseId,
      refs: facts.evidenceId === null ? [] : [facts.evidenceId],
    }, sessionId, call)
    yield usage(call, 4_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 3) {
    yield* toolCall('watch_decide', {
      caseId: facts.caseId,
      action: 'coach',
      target: { kind: 'swarm_run', id: RUN_ID },
      params: { runId: RUN_ID, text: 'Keep the current task and re-check the budget before the next dispatch.' },
      evidenceRefs: facts.evidenceId === null ? [] : [facts.evidenceId],
      reason: 'The case card shows a soft anomaly; coaching is the smallest reversible action.',
      confidence: 0.8,
      expectedEffect: 'The run continues with a recorded steer.',
      rollbackPlan: 'None: coach only records an event.',
    }, sessionId, call)
    yield usage(call, 4_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  yield* textReply('ABC fake watch decision submitted')
  yield usage(call, 2_000)
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** @param {string} name @param {Record<string, unknown>} args @param {string} sessionId @param {number} call */
function* toolCall(name, args, sessionId, call) {
  const id = `call_${sessionId}_${call}`
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
}

/** @param {string} text */
function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

/** @param {number} attempt @param {number} [input] */
function usage(attempt, input = 600) {
  return {
    type: 'usage',
    usage: {
      inputTokens: input + attempt * 50,
      outputTokens: 20,
      cacheReadTokens: attempt > 1 ? 100 : 0,
      cacheWriteTokens: 10,
    },
  }
}

async function waitForDone() {
  if (DONE === '') {
    await sleep(30_000)
    return
  }
  const deadline = Date.now() + DONE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(DONE)) return
    await sleep(500)
  }
}

/** @param {readonly any[] | undefined} messages */
function allUserText(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .filter(message => message?.role === 'user')
    .map(message => contentText(message.content))
    .join('\n')
}

/** @param {any} content */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n')
}

/** @param {string} text @param {RegExp} pattern */
function matchGroup(text, pattern) {
  const match = pattern.exec(text)
  return match === null ? null : match[1]
}

/** @param {Record<string, unknown>} record */
function logRequest(record) {
  if (LOG === '') return
  try {
    mkdirSync(path.dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // evidence only
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {any} ctx */
export function apply(ctx) {
  const adapter = createAdapter('fake', 'fake-1')
  ctx.effect(() => ctx.llm.registerAdapter(['fake'], adapter))
  ctx.logger?.info?.('[fake-llm-abc] scripted adapter registered for provider "fake"')
}
