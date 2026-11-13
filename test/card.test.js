import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedActions, buildCaseCard, buildEvidence } from '../src/card.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({ supervisor: { maxEvidenceBytes: 8_192 } })

function record(severity = 'L2') {
  return {
    id: 'case_1',
    runId: 'run-1',
    generation: 2,
    severity,
    code: 'budget_pressure',
    title: 'run budget at 81.0% (threshold 80.0%)',
    state: 'open',
    signals: [{ code: 'budget_pressure', severity, value: 0.81, at: '2026-11-14T02:00:00.000Z', observed: { threshold: 0.8 } }],
    evidence: [
      { id: 'ev_swarm_budget_run:run-1:budget_pressure', kind: 'budget', source: 'swarm', at: '2026-11-14T02:00:00.000Z', observed: { ratio: 0.81 } },
    ],
    actions: [],
    decisions: [],
  }
}

function snapshot() {
  return {
    status: 'running',
    round: 2,
    goal: 'make the exporter stream',
    budget: { limit: 1_000_000, spent: 810_000, ratio: 0.81 },
    members: Array.from({ length: 32 }, (_, index) => ({
      id: `mem_${index}`,
      name: `worker-${index}`,
      role: index === 0 ? 'queen' : 'worker',
      status: 'busy',
      context: 0.5,
      failures: 0,
    })),
    tasks: { queued: 2, working: 1, reviewing: 1 },
    reviews: { open: 1, oldestMs: 42_000 },
    merge: { queue: 1, conflicts: 0 },
    lastEventAt: '2026-11-14T02:00:01.000Z',
  }
}

test('the card carries severity-scoped allowed actions and a bounded snapshot', () => {
  const card = buildCaseCard({ record: record('L2'), snapshot: snapshot(), config })
  assert.deepEqual(card.allowedActions, ['notice', 'coach', 'throttle', 'escalate'])
  assert.equal(card.generation, 2)
  assert.equal(card.evidenceIds.length, 1)
  assert.equal(card.snapshot.members.length, 12)
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 8_192)
  assert.deepEqual(allowedActions('L4'), ['notice', 'escalate', 'pause', 'abort'])
  assert.deepEqual(allowedActions('L1'), ['notice', 'escalate'])
})

test('a card with a large snapshot is shrunk under the byte budget instead of truncated JSON', () => {
  const big = snapshot()
  big.goal = 'x'.repeat(20_000)
  big.members = Array.from({ length: 100 }, (_, index) => ({ id: `mem_${index}`, name: `worker-${index}`, role: 'worker', status: 'busy', context: 0.9, failures: 9 }))
  const card = buildCaseCard({ record: record('L3'), snapshot: big, config })
  const text = JSON.stringify(card)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8_192)
  assert.doesNotThrow(() => JSON.parse(text))
})

test('recent events are summarized into the card and capped', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, type: 'swarm/status/changed', at: '2026-11-14T02:00:00.000Z', summary: `event ${index}` }))
  const card = buildCaseCard({ record: record(), snapshot: snapshot(), config, events })
  assert.equal(card.recentEvents.length, 8)
  assert.equal(card.recentEvents.at(-1).seq, 20)
})

test('evidence resolves ids and swarm event refs, and reports unknown refs', () => {
  const result = buildEvidence({
    record: record(),
    refs: ['ev_swarm_budget_run:run-1:budget_pressure', 'swarm_event:7', 'missing'],
    events: [{ seq: 7, type: 'swarm/dispatch/started', at: '2026-11-14T02:00:00.000Z', summary: 'dispatch started' }],
  })
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].kind, 'budget')
  assert.equal(result.items[1].type, 'swarm/dispatch/started')
  assert.equal(result.items[2].error, 'not_found')
  assert.ok(result.bytes > 0)
})

test('evidence is truncated when the requested refs exceed the byte budget', () => {
  const big = record()
  big.evidence = Array.from({ length: 8 }, (_, index) => ({
    id: `ev_${index}`,
    kind: 'budget',
    source: 'swarm',
    at: '2026-11-14T02:00:00.000Z',
    observed: { blob: 'x'.repeat(1_400) },
  }))
  const result = buildEvidence({ record: big, refs: big.evidence.map(entry => entry.id), maxBytes: 2_000 })
  assert.equal(result.truncated, true)
  assert.ok(result.bytes <= 2_000)
})
