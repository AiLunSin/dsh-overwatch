/**
 * Offline scripted provider for the M2 headless probe.
 *
 * Two personas are selected by the tool table, not by a prompt hack:
 * - a root session sees `watch_arm` and arms supervised, waits, then disarms;
 * - a watch child sees `watch_decide` and walks watch_case → watch_evidence →
 *   watch_decide(coach).
 *
 * Every request is appended to `$OVERWATCH_M2_LLM_LOG` (session id, call number,
 * tool names) so the runner can prove the child's visible tool set.
 * @module dsh-fake-llm-m2
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const name = 'fake-llm-m2'
export const inject = ['llm']

const LOG = process.env.OVERWATCH_M2_LLM_LOG ?? ''

/** @type {Map<string, number>} */
const callsBySession = new Map()
/** @type {Map<string, { caseId: string | null, evidenceId: string | null }>} */
const factsBySession = new Map()

/** @param {string} provider @param {string} model */
function createAdapter(provider, model) {
  return {
    providerInfo() {
      return { id: provider, name: 'Fake scripted provider (M2)' }
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
      const toolNames = tools.map(tool => String(tool.name ?? ''))
      const sessionId = String(options?.sessionId ?? 'unknown')
      if (tools.length === 0) {
        yield usage(0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const call = (callsBySession.get(sessionId) ?? 0) + 1
      callsBySession.set(sessionId, call)
      const allUser = allUserText(options?.messages)
      const hasToolResult = Array.isArray(options?.messages) && options.messages.some(message => message?.role === 'tool')
      logRequest({ sessionId, call, toolNames, hasToolResult, at: new Date().toISOString() })

      if (toolNames.includes('watch_arm')) {
        yield* rootPersona({ sessionId, call, hasToolResult })
        return
      }
      if (toolNames.includes('watch_decide')) {
        yield* watchPersona({ sessionId, call, hasToolResult, allUser })
        return
      }
      yield* textReply('fake-llm-m2: no persona for this tool table')
      yield usage(call)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * Root: arm supervised, hold the turn long enough for the first wake, disarm.
 * @param {{ sessionId: string, call: number, hasToolResult: boolean }} input
 */
async function* rootPersona(input) {
  const { sessionId, call, hasToolResult } = input
  if (!hasToolResult) {
    yield* toolCall('watch_arm', {
      runId: 'swarm_m2',
      mode: 'supervised',
    }, sessionId, call)
    yield usage(call, 2_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 2) {
    // Let the 500ms sampler open the L2 case (two ticks), wake the officer and
    // execute its decision before the root disarms.
    yield usage(call, 1_000)
    await sleep(3_500)
    yield* toolCall('watch_disarm', { runId: 'swarm_m2', reason: 'M2 e2e complete' }, sessionId, call)
    yield usage(call, 1_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  yield* textReply('M2 root done')
  yield usage(call, 1_000)
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Watch: parse the case card from the prompt, then walk the three tools.
 * @param {{ sessionId: string, call: number, hasToolResult: boolean, allUser: string }} input
 */
function* watchPersona(input) {
  const { sessionId, call, hasToolResult, allUser } = input
  let facts = factsBySession.get(sessionId)
  if (facts === undefined) {
    facts = {
      caseId: matchGroup(allUser, /"caseId"\s*:\s*"(case_[A-Za-z0-9_-]+)"/),
      evidenceId: matchGroup(allUser, /"evidenceIds"\s*:\s*\[\s*"([^"]+)"/),
    }
    factsBySession.set(sessionId, facts)
  }
  if (facts.caseId === null) {
    yield* textReply('M2 watch: case card missing a caseId')
    yield usage(call, 2_000)
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  if (!hasToolResult) {
    yield* toolCall('watch_case', {}, sessionId, call)
    yield usage(call, 5_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 2) {
    yield* toolCall('watch_evidence', {
      caseId: facts.caseId,
      refs: facts.evidenceId === null ? [] : [facts.evidenceId],
    }, sessionId, call)
    yield usage(call, 6_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  if (call === 3) {
    yield* toolCall('watch_decide', {
      caseId: facts.caseId,
      action: 'coach',
      target: { kind: 'swarm_run', id: 'swarm_m2' },
      params: { runId: 'swarm_m2', text: 'The run is under budget pressure; keep the member on task and re-check in ten minutes.' },
      evidenceRefs: facts.evidenceId === null ? [] : [facts.evidenceId],
      reason: 'Budget pressure crossed the soft threshold while one member stays busy; coaching is the smallest reversible action.',
      confidence: 0.82,
      expectedEffect: 'The member keeps its task and the run stays inside the budget.',
      rollbackPlan: 'None needed: coach only records a steer event.',
    }, sessionId, call)
    yield usage(call, 7_000)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  yield* textReply('M2 watch decision submitted')
  yield usage(call, 7_000)
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
function usage(attempt, input = 1_000) {
  return {
    type: 'usage',
    usage: {
      inputTokens: input + attempt * 100,
      outputTokens: 40,
      cacheReadTokens: attempt > 1 ? 400 : 0,
      cacheWriteTokens: 20,
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
  ctx.logger?.info?.('[fake-llm-m2] scripted adapter registered for provider "fake"')
}
