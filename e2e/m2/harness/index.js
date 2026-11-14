/**
 * Test-only in-process swarm HTTP surface for the M2 headless harness.
 *
 * It implements just enough of the dsh-swarm contract for overwatch M1/M2:
 * health, run snapshot, events, and `intervene`. Every write is appended to
 * `$OVERWATCH_M2_CALLS` so the runner can prove that a watch decision reached
 * the upstream.
 * @module dsh-overwatch-m2-harness
 */

import { createServer } from 'node:http'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-overwatch-m2-harness'
export const inject = []

const STATE_FILE = process.env.OVERWATCH_M2_CALLS ?? ''

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const port = Number(config.port ?? 0)
  const token = String(config.token ?? '')
  const runId = String(config.runId ?? 'swarm_m2')
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) throw new Error(`m2-harness: invalid runId ${runId}`)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`m2-harness: invalid port ${String(config.port)}`)
  if (token === '') throw new Error('m2-harness: token is required')

  const state = {
    status: 'running',
    calls: [],
    events: [],
    seq: 0,
    startedAt: Date.now(),
  }
  /** @param {string} type @param {any} payload */
  function emit(type, payload = {}) {
    state.seq += 1
    state.events.push({ seq: state.seq, id: `evt_${state.seq}`, type, at: new Date().toISOString(), actor: 'system', payload })
    if (state.events.length > 200) state.events.shift()
  }
  /** @param {any} payload */
  function save(payload) {
    if (STATE_FILE === '') return
    try {
      mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      const tmp = `${STATE_FILE}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, STATE_FILE)
    } catch (error) {
      ctx.logger?.warn?.(`[m2-harness] could not write calls: ${messageOf(error)}`)
      try {
        unlinkSync(`${STATE_FILE}.${process.pid}.tmp`)
      } catch {
        // ignore
      }
    }
  }
  function snapshot() {
    const limit = 1_000_000
    const used = Math.round(limit * 0.81)
    return {
      swarmId: runId,
      runId,
      goal: 'M2 supervised probe',
      repo: 'C:/tmp/repo',
      topology: 'mesh',
      mode: 'swarm',
      status: state.status,
      round: 1,
      concurrencyLimit: 2,
      createdAt: state.startedAt,
      updatedAt: Date.now(),
      endedAt: null,
      recovered: false,
      convergedReason: null,
      baseCommit: '',
      gateCommands: [],
      workspace: { enabled: false, integrationBranch: null, degraded: 0, conflicts: 0 },
      dispatch: { auto: false, active: 1, parentBound: true },
      preflight: null,
      convergence: { converged: false, openTasks: 1, budgetRatio: 0.81, budgetExhausted: false },
      stats: { members: 2, tasks: 1, merged: 0, failed: 0, active: 1, boardEntries: 0, events: state.events.length },
      budget: {
        limits: { runTokens: limit, runUsd: 0, runWallMs: 0, taskTokens: 400_000, memberTokens: 800_000 },
        run: { tokens: used, reservedTokens: 0, calls: 3, usd: 0, reservedUsd: 0, wallMs: 0 },
        tasks: {},
        members: {},
        reservations: 0,
      },
      members: [
        { id: 'member_queen', name: 'queen', role: 'queen', model: 'inherit', status: 'busy', load: 0, stats: { won: 0, done: 0, failed: 0 }, joinedAt: state.startedAt, lastWinRound: 0, skills: [] },
        { id: 'member_worker', name: 'worker-1', role: 'worker', model: 'fast', status: 'busy', load: 1, stats: { won: 0, done: 0, failed: 0 }, joinedAt: state.startedAt, lastWinRound: 0, skills: ['.js'] },
      ],
      tasks: [{ id: 'task_1', title: 'probe task', state: 'working', assignee: 'member_worker' }],
    }
  }
  function json(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const pathname = url.pathname
      if (pathname === '/swarm/api/health') {
        json(res, 200, { ok: true, runs: 1, baseDir: 'm2-harness' })
        return
      }
      if (pathname === '/swarm/api/runs' && req.method === 'GET') {
        json(res, 200, {
          runs: [{
            swarmId: runId,
            goal: 'M2 supervised probe',
            status: state.status,
            tasks: 1,
            members: 2,
            createdAt: state.startedAt,
            updatedAt: Date.now(),
          }],
        })
        return
      }
      if (pathname === `/swarm/api/runs/${runId}` && req.method === 'GET') {
        json(res, 200, snapshot())
        return
      }
      if (pathname === `/swarm/api/runs/${runId}/events` && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1_000)
        json(res, 200, { runId, events: state.events.filter(event => event.seq > since).slice(0, limit) })
        return
      }
      if (pathname === `/swarm/api/runs/${runId}/intervene` && req.method === 'POST') {
        if (req.headers['x-swarm-token'] !== token) {
          json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bad swarm token' } })
          return
        }
        const body = await readBody(req)
        const action = String(body.action ?? '')
        if (action === 'pause') {
          if (state.status !== 'running') {
            json(res, 409, { error: { code: 'RUN_NOT_RUNNING', message: `cannot pause from ${state.status}` } })
            return
          }
          state.status = 'paused'
          emit('swarm/status/changed', { from: 'running', to: 'paused' })
        } else if (action === 'resume') {
          if (state.status !== 'paused') {
            json(res, 409, { error: { code: 'RUN_NOT_RUNNING', message: `cannot resume from ${state.status}` } })
            return
          }
          state.status = 'running'
          emit('swarm/status/changed', { from: 'paused', to: 'running' })
        } else if (action === 'abort') {
          state.status = 'aborted'
          emit('swarm/aborted', { reason: String(body.reason ?? '') })
        } else if (action === 'steer') {
          emit('swarm/intervened', { action: 'steer', text: String(body.text ?? ''), target: body.target ?? null })
        } else {
          json(res, 400, { error: { code: 'INVALID_ACTION', message: `unknown action ${action}` } })
          return
        }
        state.calls.push({ action, body, at: new Date().toISOString(), status: state.status })
        save({ calls: state.calls, status: state.status, events: state.events })
        json(res, 200, snapshot())
        return
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: `no route ${pathname}` } })
    } catch (error) {
      json(res, 500, { error: { code: 'INTERNAL', message: messageOf(error) } })
    }
  })

  ctx.effect(() => () => new Promise(resolve => server.close(() => resolve(undefined))))
  server.listen(port, '127.0.0.1', () => {
    ctx.logger?.info?.(`[m2-harness] fake swarm listening on 127.0.0.1:${port}`)
    emit('swarm/created', { runId })
    emit('swarm/dispatch/started', { memberId: 'member_worker', childId: 'sess_worker', taskId: 'task_1' })
    save({ calls: state.calls, status: state.status, events: state.events })
  })
  server.on('error', error => ctx.logger?.warn?.(`[m2-harness] server error: ${messageOf(error)}`))
}
