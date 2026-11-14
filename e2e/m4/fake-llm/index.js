/**
 * Scripted root provider for the M4 real-model watch probe.
 *
 * The root agent is deliberately fake: it arms supervised, waits until the
 * *real* watch child submits a decision (or the wake times out), then disarms.
 * The watch child itself is routed to a real provider/model by
 * `supervisor.agentOptions`, so this probe measures one real watch wake without
 * paying for a scripted root.
 * @module dsh-fake-llm-m4
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'fake-llm-m4'
export const inject = ['llm']

const LOG = process.env.OVERWATCH_M4_LLM_LOG ?? ''
const WATCH = process.env.OVERWATCH_M4_WATCH ?? ''
const HOLD_MS = 150_000

/** @param {string} provider @param {string} model */
function createAdapter(provider, model) {
  return {
    providerInfo() {
      return { id: provider, name: 'Fake root provider (M4)' }
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
      const call = countCall(sessionId)
      logRequest({ sessionId, call, toolNames, hasToolResult: hasToolResult(options?.messages) })
      if (!toolNames.includes('watch_arm')) {
        yield* textReply('fake-m4: not the root tool table')
        yield usage(call, 100)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!hasToolResult(options?.messages)) {
        yield* toolCall('watch_arm', { runId: 'swarm_m4', mode: 'supervised' }, sessionId, call)
        yield usage(call, 300)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (call === 2) {
        yield usage(call, 200)
        await waitForWatchOutcome()
        yield* toolCall('watch_disarm', { runId: 'swarm_m4', reason: 'M4 real-watch probe complete' }, sessionId, call)
        yield usage(call, 200)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textReply('M4 root done')
      yield usage(call, 200)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** Wait until the watch log shows a decision/timeout/disarm, or the hold expires. */
async function waitForWatchOutcome() {
  if (WATCH === '') return
  const deadline = Date.now() + HOLD_MS
  while (Date.now() < deadline) {
    try {
      const text = existsSync(WATCH) ? readFileSync(WATCH, 'utf8') : ''
      if (text.includes('"watch/decision"') || text.includes('"watch/wake/timeout"') || text.includes('"watch/disarmed"')) return
    } catch {
      // retry
    }
    await delay(500)
  }
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
function usage(attempt, input = 1_000) {
  return { type: 'usage', usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

/** @type {Map<string, number>} */
const calls = new Map()

/** @param {string} sessionId */
function countCall(sessionId) {
  const next = (calls.get(sessionId) ?? 0) + 1
  calls.set(sessionId, next)
  return next
}

/** @param {readonly any[] | undefined} messages */
function hasToolResult(messages) {
  return Array.isArray(messages) && messages.some(message => message?.role === 'tool')
}

/** @param {Record<string, unknown>} record */
function logRequest(record) {
  if (LOG === '') return
  try {
    mkdirSync(path.dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8')
  } catch {
    // evidence only
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {any} ctx */
export function apply(ctx) {
  const adapter = createAdapter('fake', 'fake-1')
  ctx.effect(() => ctx.llm.registerAdapter(['fake'], adapter))
  ctx.logger?.info?.('[fake-llm-m4] scripted root adapter registered')
}
