/**
 * Probe / sampler: reads the three upstreams into one normalized snapshot.
 *
 * It does not judge and does not act. Its only state is a cursor, a bounded
 * event buffer, per-source freshness, and the member→child session map that lets
 * pressure readings be attached to swarm members. Every call is timeout-bounded
 * by the port, and every failure is recorded as `ok:false` instead of being
 * papered over with zeros.
 * @module dsh-overwatch/probe
 */

const MAX_EVENTS = 5_000
const MAX_BATCHES = 5
const EVENT_BATCH = 200

/** @typedef {{ ok: boolean, at: string | null, error: string | null }} SourceState */

export class Probe {
  /**
   * @param {object} options
   * @param {{ swarm: import('./ports/swarm.js').SwarmPort, pressure: import('./ports/pressure.js').PressurePort, fish: import('./ports/fish.js').FishPort }} options.ports
   * @param {typeof import('./config.js').DEFAULT_CONFIG} options.config
   * @param {() => number} [options.clock]
   * @param {{ warn?: (message: string) => void }} [options.logger]
   */
  constructor(options) {
    this.ports = options.ports
    this.config = options.config
    this.clock = options.clock ?? Date.now
    this.logger = options.logger
    /** @type {Map<string, RunProbeState>} */
    this.runs = new Map()
  }

  /**
   * Full first sample: snapshot, events from zero, and (best-effort) pressure and
   * fish. A failure here is reported to the caller so arm can refuse to supervise
   * a run it cannot see.
   * @param {string} runId
   * @returns {Promise<{ ok: boolean, error: string | null, snapshot: any }>}
   */
  async prime(runId) {
    const state = this.#state(runId)
    state.due = { events: 0, snapshot: 0, pressure: 0, fish: 0 }
    await this.tick(runId, this.clock())
    const swarm = state.last.swarm
    return {
      ok: swarm.ok,
      error: swarm.error,
      snapshot: state.snapshot,
    }
  }

  /**
   * Incremental sample. Only the sources whose interval elapsed are called.
   * @param {string} runId
   * @param {number} now
   * @returns {Promise<{ snapshot: any, newEvents: any[], freshness: any }>}
   */
  async tick(runId, now) {
    const state = this.#state(runId)
    const before = state.events.length

    if (now >= state.due.events) await this.#sampleEvents(state, now)
    if (now >= state.due.snapshot) await this.#sampleSnapshot(state, now)
    if (now >= state.due.pressure) await this.#samplePressure(state, now)
    if (now >= state.due.fish) await this.#sampleFish(state, now)

    state.snapshot.asOf = new Date(now).toISOString()
    state.snapshot.freshness = this.freshness(runId)
    state.snapshot.lastEventSeq = state.cursor
    state.snapshot.eventGap = state.gap
    if (state.events.length > 0) state.snapshot.lastEventAt = state.events.at(-1)?.at ?? state.snapshot.lastEventAt
    return {
      snapshot: state.snapshot,
      newEvents: state.events.slice(before),
      freshness: state.snapshot.freshness,
    }
  }

  /** @param {string} runId */
  snapshot(runId) {
    return this.runs.get(runId)?.snapshot ?? null
  }

  /** @param {string} runId */
  freshness(runId) {
    const state = this.runs.get(runId)
    if (state === undefined) return { swarm: source(false, null, 'not sampled'), pressure: source(false, null, 'not sampled'), fish: source(false, null, 'not sampled') }
    const now = this.clock()
    return {
      swarm: source(state.last.swarm.ok, state.last.swarm.at, state.last.swarm.error, now),
      pressure: source(state.last.pressure.ok, state.last.pressure.at, state.last.pressure.error, now),
      fish: source(state.last.fish.ok, state.last.fish.at, state.last.fish.error, now),
    }
  }

  /**
   * @param {string} runId
   * @param {{ since?: number, limit?: number }} [query]
   */
  events(runId, query = {}) {
    const state = this.runs.get(runId)
    if (state === undefined) return []
    const since = query.since ?? 0
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1_000)
    return state.events.filter(event => event.seq > since).slice(0, limit)
  }

  /**
   * Recorded pressure samples, oldest first, for the merged timeline. Bounded to
   * the last 500 readings.
   * @param {string} runId
   */
  pressureEvents(runId) {
    return this.runs.get(runId)?.pressureSamples ?? []
  }

  /** @param {string} runId */
  close(runId) {
    if (runId !== undefined) this.runs.delete(runId)
    else this.runs.clear()
  }

  /** @param {string} runId */
  #state(runId) {
    let state = this.runs.get(runId)
    if (state === undefined) {
      state = {
        runId,
        cursor: 0,
        events: [],
        gap: null,
        rebuiltAfterGap: false,
        due: { events: 0, snapshot: 0, pressure: 0, fish: 0 },
        failures: { events: 0, snapshot: 0, pressure: 0, fish: 0 },
        last: { swarm: fresh(), pressure: fresh(), fish: fresh() },
        childByMember: new Map(),
        pressureByChild: new Map(),
        pressureSamples: [],
        raw: null,
        snapshot: emptySnapshot(runId, new Date(this.clock()).toISOString()),
      }
      this.runs.set(runId, state)
    }
    return state
  }

  /** @param {RunProbeState} state @param {number} now */
  async #sampleEvents(state, now) {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const response = await this.ports.swarm.events(state.runId, { since: state.cursor, limit: EVENT_BATCH })
      if (response.ok !== true || !Array.isArray(response.data?.events)) {
        this.#fail(state, 'events', now, errorOf(response))
        return
      }
      const list = response.data.events
      if (list.length === 0) break
      const firstSeq = Number(list[0]?.seq)
      if (state.cursor > 0 && Number.isFinite(firstSeq) && firstSeq !== state.cursor + 1 && state.gap === null) {
        state.gap = { expectedSeq: state.cursor + 1, actualSeq: firstSeq, at: new Date(now).toISOString() }
        this.logger?.warn?.(`[overwatch] swarm event gap in ${state.runId}: expected ${state.cursor + 1}, got ${firstSeq}`)
      }
      for (const event of list) this.#ingestEvent(state, event)
      const lastSeq = Number(list.at(-1)?.seq)
      if (!Number.isFinite(lastSeq) || lastSeq <= state.cursor) {
        this.#fail(state, 'events', now, 'event cursor did not advance')
        return
      }
      state.cursor = lastSeq
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
      if (list.length < EVENT_BATCH) break
    }
    if (state.gap !== null && !state.rebuiltAfterGap) {
      state.rebuiltAfterGap = true
      await this.#rebuildEvents(state)
    }
    this.#succeed(state, 'events', now)
    state.due.events = now + this.config.sampling.swarmEventMs
  }

  /**
   * After a sequence gap, re-read the stream from zero once so the panel timeline
   * is continuous again. The gap itself stays latched: the guard must still stop.
   * @param {RunProbeState} state
   */
  async #rebuildEvents(state) {
    const response = await this.ports.swarm.events(state.runId, { since: 0, limit: 1_000 })
    if (response.ok !== true || !Array.isArray(response.data?.events)) return
    state.events = []
    state.cursor = 0
    for (const event of response.data.events) this.#ingestEvent(state, event)
    state.cursor = Number(response.data.events.at(-1)?.seq ?? 0) || 0
  }

  /** @param {RunProbeState} state @param {number} now */
  async #sampleSnapshot(state, now) {
    const response = await this.ports.swarm.run(state.runId)
    if (response.ok !== true || response.data === null || typeof response.data !== 'object') {
      this.#fail(state, 'snapshot', now, errorOf(response), 'swarm')
      return
    }
    const raw = /** @type {any} */ (response.data)
    state.raw = raw
    state.snapshot = normalizeSnapshot(state, raw, now)
    if (state.snapshot.lastEventAt === null) state.snapshot.lastEventAt = isoOf(raw.updatedAt) ?? isoOf(raw.createdAt)
    this.#succeed(state, 'snapshot', now, 'swarm')
    state.due.snapshot = now + this.config.sampling.swarmSnapshotMs
  }

  /** @param {RunProbeState} state @param {number} now */
  async #samplePressure(state, now) {
    const memberIds = [...state.childByMember.entries()].slice(0, 8)
    if (memberIds.length === 0) {
      state.due.pressure = now + this.config.sampling.pressureMs
      return
    }
    let anyOk = false
    let lastError = 'no member session yet'
    const limit = Math.max(1, Math.min(this.config.sampling.maxInflight, memberIds.length))
    for (let index = 0; index < memberIds.length; index += limit) {
      const slice = memberIds.slice(index, index + limit)
      const results = await Promise.all(slice.map(async ([memberId, childId]) => {
        const response = await this.ports.pressure.live(childId)
        return { memberId, childId, response }
      }))
      for (const { memberId, childId, response } of results) {
        if (process.env.OW_DEBUG) console.error('[probe] pressure resp', memberId, response.ok)
        if (response.ok !== true) {
          lastError = errorOf(response)
          continue
        }
        const view = response.data?.data ?? response.data ?? {}
        const pressure = toNumber(view?.context?.pressure)
        const tokens = view?.tokens ?? null
        state.pressureByChild.set(memberId, {
          ratio: pressure,
          tokens: tokens?.total ?? null,
          failures: toNumber(view?.tools?.failures) ?? 0,
          repeats: toNumber(view?.tools?.repeats) ?? 0,
          at: new Date(now).toISOString(),
          source: 'pressure',
        })
        state.pressureSamples.push({
          at: new Date(now).toISOString(),
          memberId,
          childId,
          ratio: pressure,
          failures: toNumber(view?.tools?.failures) ?? 0,
        })
        if (state.pressureSamples.length > 500) state.pressureSamples.splice(0, state.pressureSamples.length - 500)
        anyOk = true
      }
    }
    if (anyOk) {
      state.last.pressure = { ok: true, at: new Date(now).toISOString(), error: null }
      this.#attachPressure(state)
      state.due.pressure = now + this.config.sampling.pressureMs
    } else {
      this.#fail(state, 'pressure', now, lastError, 'pressure')
    }
  }

  /** @param {RunProbeState} state @param {number} now */
  async #sampleFish(state, now) {
    const response = await this.ports.fish.overview()
    if (response.ok !== true) {
      // Expected on the Host: fishkeeper routes need a browser credential. This
      // is a capability fact, not a health failure of the supervised run.
      state.last.fish = { ok: false, at: new Date(now).toISOString(), error: errorOf(response) }
      state.due.fish = now + Math.min(this.config.sampling.fishMs * 4, 120_000)
      return
    }
    state.last.fish = { ok: true, at: new Date(now).toISOString(), error: null }
    state.snapshot.fish = summarizeFish(response.data)
    state.due.fish = now + this.config.sampling.fishMs
  }

  /** @param {RunProbeState} state @param {any} event */
  #ingestEvent(state, event) {
    const payload = event?.payload ?? {}
    if (typeof payload.memberId === 'string' && typeof payload.childId === 'string') {
      state.childByMember.set(payload.memberId, payload.childId)
    }
    if (typeof payload.memberId === 'string' && typeof payload.childId !== 'string'
      && /dispatch\/(started|finished)/.test(String(event?.type))) {
      // A finished dispatch without a childId keeps the last mapping for grace.
    }
    const normalized = {
      seq: Number(event.seq),
      type: String(event.type ?? 'unknown'),
      at: isoOf(event.at) ?? new Date(this.clock()).toISOString(),
      actor: String(event.actor ?? 'swarm'),
      summary: summarizeSwarmEvent(event),
    }
    if (!Number.isFinite(normalized.seq)) return
    state.events.push(normalized)
  }

  /** @param {RunProbeState} state */
  #attachPressure(state) {
    for (const member of state.snapshot.members) {
      const reading = member.childId === null ? null : state.pressureByChild.get(member.id)
      member.context = reading?.ratio ?? null
      member.failures = reading?.failures ?? null
      member.repeats = reading?.repeats ?? null
      member.pressureAt = reading?.at ?? null
    }
  }

  /**
   * @param {RunProbeState} state
   * @param {'events'|'snapshot'|'pressure'|'fish'} key
   * @param {number} now
   * @param {string} error
   * @param {'swarm'|'pressure'|'fish'} sourceKey
   */
  #fail(state, key, now, error, sourceKey = 'swarm') {
    state.failures[key] += 1
    const base = key === 'events' ? this.config.sampling.swarmEventMs
      : key === 'snapshot' ? this.config.sampling.swarmSnapshotMs
        : key === 'pressure' ? this.config.sampling.pressureMs
          : this.config.sampling.fishMs
    const backoff = Math.min(base * 2 ** Math.min(state.failures[key], 5), 15_000)
    state.due[key] = now + backoff
    state.last[sourceKey] = { ok: false, at: new Date(now).toISOString(), error }
  }

  /**
   * @param {RunProbeState} state
   * @param {'events'|'snapshot'|'pressure'|'fish'} key
   * @param {number} now
   * @param {'swarm'|'pressure'|'fish'} sourceKey
   */
  #succeed(state, key, now, sourceKey = 'swarm') {
    state.failures[key] = 0
    state.last[sourceKey] = { ok: true, at: new Date(now).toISOString(), error: null }
  }
}

/** @typedef {object} RunProbeState
 * @property {string} runId
 * @property {number} cursor
 * @property {any[]} events
 * @property {{ expectedSeq: number, actualSeq: number, at: string } | null} gap
 * @property {boolean} rebuiltAfterGap
 * @property {{ events: number, snapshot: number, pressure: number, fish: number }} due
 * @property {{ events: number, snapshot: number, pressure: number, fish: number }} failures
 * @property {{ swarm: SourceState, pressure: SourceState, fish: SourceState }} last
 * @property {Map<string, string>} childByMember
 * @property {Map<string, any>} pressureByChild
 * @property {any} raw
 * @property {any} snapshot
 */

/** @param {string} runId @param {string} now */
function emptySnapshot(runId, now) {
  return {
    schemaVersion: 1,
    runId,
    asOf: now,
    status: 'unknown',
    round: 0,
    goal: null,
    budget: { limit: 0, spent: 0, reserved: 0, ratio: 0, remaining: 0 },
    members: [],
    tasks: { queued: 0, working: 0, reviewing: 0, approved: 0, blocked: 0, merged: 0, failed: 0, total: 0 },
    reviews: { open: 0, noQuorum: 0, oldestMs: null, known: false },
    merge: { queue: 0, conflicts: 0, lastMergeAt: null },
    workspace: { conflicts: 0, worktrees: null },
    dispatch: { auto: false, active: 0 },
    fish: null,
    lastEventSeq: 0,
    lastEventAt: null,
    eventGap: null,
    freshness: null,
  }
}

/** @param {RunProbeState} state @param {any} raw @param {number} now */
function normalizeSnapshot(state, raw, now) {
  const budget = raw.budget ?? {}
  const ledger = budget.run ?? {}
  const limit = toNumber(budget.limits?.runTokens) ?? 0
  const spent = (toNumber(ledger.tokens) ?? 0) + (toNumber(ledger.reservedTokens) ?? 0)
  const members = Array.isArray(raw.members) ? raw.members.slice(0, 32).map(member => {
    const childId = state.childByMember.get(member.id) ?? null
    return {
      id: String(member.id),
      name: String(member.name ?? member.id),
      role: String(member.role ?? 'worker'),
      model: member.model ?? 'inherit',
      status: String(member.status ?? 'unknown'),
      load: toNumber(member.load) ?? 0,
      childId,
      taskId: typeof member.taskId === 'string' ? member.taskId : null,
      context: childId === null ? null : (state.pressureByChild.get(member.id)?.ratio ?? null),
      failures: childId === null ? null : (state.pressureByChild.get(member.id)?.failures ?? null),
      repeats: childId === null ? null : (state.pressureByChild.get(member.id)?.repeats ?? null),
      pressureAt: childId === null ? null : (state.pressureByChild.get(member.id)?.at ?? null),
    }
  }) : []
  const taskList = Array.isArray(raw.tasks) ? raw.tasks : []
  const tasks = { queued: 0, working: 0, reviewing: 0, approved: 0, blocked: 0, merged: 0, failed: 0, total: taskList.length }
  for (const task of taskList) {
    const taskState = String(task.state ?? '')
    if (taskState === 'queued' || taskState === 'awarded') tasks.queued += 1
    else if (taskState === 'working' || taskState === 'submitted') tasks.working += 1
    else if (taskState === 'reviewing') tasks.reviewing += 1
    else if (taskState === 'approved') tasks.approved += 1
    else if (taskState === 'blocked') tasks.blocked += 1
    else if (taskState === 'merged') tasks.merged += 1
    else if (taskState === 'failed' || taskState === 'cancelled' || taskState === 'expired') tasks.failed += 1
  }
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : null
  const conflictCount = toNumber(raw.workspace?.conflicts) ?? toNumber(raw.stats?.conflicts) ?? 0
  return {
    ...state.snapshot,
    runId: String(raw.runId ?? raw.swarmId ?? state.runId),
    asOf: new Date(now).toISOString(),
    status: String(raw.status ?? 'unknown'),
    round: toNumber(raw.round) ?? 0,
    goal: typeof raw.goal === 'string' ? raw.goal.slice(0, 300) : null,
    budget: {
      limit,
      spent,
      reserved: toNumber(ledger.reservedTokens) ?? 0,
      ratio: limit > 0 ? spent / limit : 0,
      remaining: Math.max(0, limit - spent),
    },
    members,
    tasks,
    reviews: reviews === null
      ? { open: 0, noQuorum: 0, oldestMs: null, known: false }
      : {
          open: reviews.filter(review => review.state !== 'closed' && review.state !== 'done').length,
          noQuorum: reviews.filter(review => review.state === 'no_quorum').length,
          oldestMs: oldestAgeMs(reviews, now),
          known: true,
        },
    merge: { queue: 0, conflicts: conflictCount, lastMergeAt: null },
    workspace: {
      conflicts: conflictCount,
      worktrees: toNumber(raw.workspace?.worktrees) ?? null,
      degraded: toNumber(raw.workspace?.degraded) ?? 0,
    },
    dispatch: {
      auto: raw.dispatch?.auto === true,
      active: toNumber(raw.dispatch?.active) ?? 0,
    },
    conversation: raw.convergence ?? null,
    lastEventAt: state.events.at(-1)?.at ?? isoOf(raw.updatedAt) ?? isoOf(raw.createdAt),
    lastEventSeq: state.cursor,
    eventGap: state.gap,
  }
}

/** @param {any[]} reviews @param {number} now */
function oldestAgeMs(reviews, now) {
  let oldest = null
  for (const review of reviews) {
    if (review.state === 'closed' || review.state === 'done') continue
    const at = isoOf(review.openedAt ?? review.createdAt)
    if (at === null) continue
    const age = now - Date.parse(at)
    if (Number.isFinite(age) && (oldest === null || age > oldest)) oldest = age
  }
  return oldest
}

/** @param {any} event */
function summarizeSwarmEvent(event) {
  const payload = event?.payload ?? {}
  const parts = []
  if (typeof payload.taskId === 'string') parts.push(`task=${payload.taskId}`)
  if (typeof payload.memberId === 'string') parts.push(`member=${payload.memberId}`)
  if (typeof payload.member?.id === 'string') parts.push(`member=${payload.member.id}`)
  if (typeof payload.task?.id === 'string') parts.push(`task=${payload.task.id}`)
  if (typeof payload.from === 'string' && typeof payload.to === 'string') parts.push(`${payload.from}->${payload.to}`)
  if (typeof payload.tokens === 'number') parts.push(`tokens=${payload.tokens}`)
  if (typeof payload.reason === 'string' && payload.reason !== '') parts.push(`reason=${payload.reason.slice(0, 120)}`)
  const type = String(event?.type ?? 'unknown')
  return parts.length === 0 ? type : `${type} ${parts.join(' ')}`
}

/** @param {any} data */
function summarizeFish(data) {
  const view = data?.data ?? data ?? {}
  return {
    available: true,
    sources: Array.isArray(view.sources) ? view.sources.length : null,
    checkpoints: Array.isArray(view.checkpoints) ? view.checkpoints.length : null,
  }
}

/** @param {boolean} ok @param {string | null} at @param {string | null} error @param {number} [now] */
function source(ok, at, error, now = Date.now()) {
  const ageMs = at === null ? null : Math.max(0, now - Date.parse(at))
  return { ok, at, ageMs, error }
}

/** @returns {SourceState} */
function fresh() {
  return { ok: false, at: null, error: null }
}

/** @param {any} response */
function errorOf(response) {
  if (response?.error !== null && response?.error !== undefined) return String(response.error)
  return `HTTP ${String(response?.status ?? 0)}`
}

/** @param {unknown} value @returns {string | null} */
function isoOf(value) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}

/** @param {unknown} value @returns {number | null} */
function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
