/**
 * Offline scripted provider for the dsh-overwatch M0 probe.
 *
 * It scripts every agent-loop request from markers in the last user message:
 * - `M0-WATCH-TASK` 鈫?one `watch_decide` tool call, then a closing text;
 * - `M0-PING-*` 鈫?a text reply (exercises continuable sendMessage);
 * - `M0-DUMMY` 鈫?a text reply after a delay (holds a capacity slot);
 * - `M0-PRESET` 鈫?a text reply (preset child);
 * - anything else 鈫?`root ok`.
 *
 * Every request is appended to `$OVERWATCH_M0_LLM_LOG` so the probe can prove
 * what tool list the child actually received. Test only; never published.
 * @module dsh-fake-llm
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const name = 'fake-llm'
export const inject = ['llm']

const LOG = process.env.OVERWATCH_M0_LLM_LOG ?? ''

/** @type {Map<string, number>} */
const callsBySession = new Map()

/** @param {string} provider @param {string} model */
function createAdapter(provider, model) {
  return {
    providerInfo() {
      return { id: provider, name: 'Fake scripted provider' }
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
      return [{ provider, id: model, name: 'Fake scripted model' }]
    },
    async resolveModel() {
      return {
        provider,
        id: model,
        name: 'Fake scripted model',
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 4_096,
      }
    },
    async prepareCall() {
      return { model: await this.resolveModel(), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const tools = Array.isArray(options?.tools) ? options.tools : []
      const sessionId = String(options?.sessionId ?? 'unknown')
      const call = (callsBySession.get(sessionId) ?? 0) + 1
      callsBySession.set(sessionId, call)
      const lastUser = lastUserText(options?.messages)
      const allUser = allUserText(options?.messages)
      const hasToolResult = Array.isArray(options?.messages) && options.messages.some(message => message?.role === 'tool')
      const toolNames = tools.map(tool => String(tool.name ?? ''))
      logRequest({ sessionId, call, toolNames, lastUser, hasToolResult, at: new Date().toISOString() })

      // Title generation and other auxiliary calls carry no tools; answer them
      // without consuming a marker.
      if (tools.length === 0) {
        yield usage(0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (allUser.includes('M0-PING')) {
        yield* textReply(`pong ${sessionId.slice(0, 8)} call=${call}`)
        yield usage(call)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (allUser.includes('M0-ANCHOR')) {
        if (!hasToolResult && toolNames.includes('m0_hold')) {
          const args = JSON.stringify({})
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: `call_${sessionId}_${call}`, name: 'm0_hold', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call_${sessionId}_${call}`, name: 'm0_hold', arguments: args } }
          yield usage(call)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield* textReply('anchor released')
        yield usage(call)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (allUser.includes('M0-DUMMY')) {
        await delay(1_200)
        yield* textReply(`dummy ok ${sessionId.slice(0, 8)}`)
        yield usage(call)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (allUser.includes('M0-PRESET')) {
        yield* textReply('preset ok')
        yield usage(call)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (allUser.includes('M0-WATCH-TASK')) {
        if (!hasToolResult && toolNames.includes('watch_decide')) {
          const args = JSON.stringify({
            caseId: 'case-m0',
            action: 'throttle',
            target: { kind: 'swarm_run', id: 'run-m0' },
            params: { runId: 'run-m0', text: 'reduce member concurrency' },
            evidenceRefs: ['ev-budget-1'],
            reason: 'run budget is at 96% of its limit',
            confidence: 0.9,
          })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: `call_${sessionId}_${call}`, name: 'watch_decide', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call_${sessionId}_${call}`, name: 'watch_decide', arguments: args } }
          yield usage(call)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield* textReply('watch decision submitted; closing the probe turn.')
        yield usage(call)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      yield* textReply('root ok')
      yield usage(call)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
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

/** @param {readonly any[] | undefined} messages */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    return contentText(message.content)
  }
  return ''
}

/** @param {any} content */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('\n')
}

/** @param {string} text */
function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

/** @param {number} attempt */
function usage(attempt) {
  return {
    type: 'usage',
    usage: {
      inputTokens: 1_000 + attempt * 100,
      outputTokens: 40,
      cacheReadTokens: attempt > 1 ? 400 : 0,
      cacheWriteTokens: 20,
    },
  }
}

/** @param {Record<string, unknown>} record */
function logRequest(record) {
  if (LOG === '') return
  try {
    mkdirSync(path.dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Logging is evidence, never a reason to fail a turn.
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
  ctx.logger?.info?.('[fake-llm] scripted adapter registered for provider "fake"')
}
