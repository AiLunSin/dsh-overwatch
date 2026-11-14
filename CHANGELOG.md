# Changelog

All notable changes are recorded here. The project follows SemVer once it
publishes; until then the minor version tracks milestones.

## [Unreleased]

### Added — M4 real-model watch validation

- `e2e/m4`: scripted root + real DeepSeek account watch child, one wake within a
  hard 80k-token/200s budget. Real model called the three scoped tools, produced
  an accepted `coach` decision (confidence 0.82) and the executor verified it.
- `supervisor.agentOptions` routes only the watch child to a real model.
- Fixed budget evidence ids containing `[object Object]` (stable ref key), added
  `target.kind` enum and case-card target hints to `watch_decide`, and recorded
  validation `errors` on rejected decisions.
- Configurable `runId` for the fake swarm harness.

### Added — M4 hardening and release tooling

- Eight deterministic incident scenarios (I-1..I-8) including review deadlock,
  gate ping-pong and conflict storm signal rules with configurable thresholds.
- Clock-jump detection (no fabricated stalls), event-stream internal gap
  detection, store size cap test, payload scrubbing test.
- Security regression: token/origin, path traversal, oversized body, malformed
  JSON/method, confirmToken rejection, tool restriction.
- `scripts/build-release.mjs` (scoped package + bundle row + client id rewrite),
  `scripts/smoke-install.mjs` (directory and tarball installs), CI workflow.
- README.en, docs/config.md, docs/compatibility.md, docs/troubleshooting.md,
  docs/m4.md.

### Added — M3 fish tank, replay, restore evidence

- `fish-index.js`: read-only fishkeeper checkpoint index, manifest summaries and
  audit tails from `~/.dsh/fishkeeper` (or `fish.dataDir`); no blob/diary content.
- `GET /overwatch/api/fish`, `/fish/:sourceId`, `/doctor`; doctor checks data dir,
  service chain, upstreams, write token, fish index, runs and disk.
- Merged timeline: swarm + pressure samples + watch events, ordered by
  `(at, sourceRank, seq)`, opaque `nextSince` cursor.
- `POST /runs/:id/restores`: records fishkeeper restore intent/result and rejects
  any `confirmToken`; overwatch never stores or proxies the token.
- Panel: fish tab (index, checkpoints, browser-side restore flow with dryRun and
  confirmation, audit), replay tab, doctor checks, zh/en + keyboard/a11y copy.
- M1 web regression extended to 33 checks with doctor/fish/timeline/restore.

### Added — M2 watch officer (experimental)

- `WatchOfficer`: lazy `delivery:'caller'` child at the first L2+ case, reserved
  child id so serial `agent/created` can restrict before the first model request,
  idempotent re-attach on cold resume, three scoped tools only.
- `card.js`: bounded case card (≤8KB) and by-reference evidence (≤8KB, ≤3 calls).
- Run supervisor: supervised arm preconditions (root agent, write token, capacity),
  wake queue, decision/generation gating, timeout/error degradation, supervisor
  token ledger, `watch/usage`, `watch/degraded`, shift handover.
- Policy: confidence below 0.6 only allows notice/escalate.
- Panel: supervised banner, arm mode, watch officer card.
- `ports.origin` for headless/external upstream origin.
- `e2e/m2`: real DSH headless probe with a scripted provider and in-process fake
  swarm; 12/12 checks, 13-event hash chain, tool table restricted to three tools.

### Fixed

- The supervisor is registered before `arm()` so the watch child's serial
  `agent/created` listener can find it (otherwise the child was never restricted).
- Shift handover records the disposed officer's wakes/timeouts.

### Added — M1 hard guard (guard-only)

- `Probe`: one timer per run, swarm event cursor with gap latching and one
  rebuild, snapshot normalization, pressure sampling by member→child session,
  fishkeeper overview, freshness, bounded buffers and exponential backoff.
- `CaseManager`: deterministic case keys, 15-minute cooldown, L2 two-tick rule,
  severity escalation, reopen with generation, urgent `ensure()`, materialized
  case files, `closeAll()`.
- `guard.js`: deterministic plans — throttle at `budgetPressure` (pause + timed
  resume), hard pause at `budgetPause`, abort at 100%, abort on a swarm event
  gap; intervention/cooldown limits; no action without a case or write token.
- `RunSupervisor`: arming preconditions (swarm health, run state, prime), watch
  log, guard loop, case/action records, disarm with archive snapshot, timeline,
  acknowledgement, Markdown report.
- `OverwatchService`: multi-run registry, arm/disarm, readonly reading of
  historical runs, service-level life log, `health()` with per-run chain state.
- Root-agent tools `watch_arm` / `watch_disarm` / `watch_status` /
  `watch_report`, restricted by a `when` predicate and re-checked in handlers.
- `/overwatch/api` read API (runs, snapshot, cases, case detail, timeline,
  shift, export) and token-protected arm/disarm/ack/HEAD.
- `client.js`: sidebar「瞭望塔」entry plus watch-room and case views (budget
  bar with 80/95 ticks, freshness chips, case drawer, acknowledgement, guarded
  write-op form with sessionStorage token).
- M1 e2e: fake swarm plugin, probe, throwaway web-profile runner and evidence
  under `e2e/m1/`.

### Fixed

- The probe no longer marks swarm freshness unavailable when only the pressure
  service answers 404.
- `ports.swarmToken` lets the swarm write token differ from the overwatch write
  token (it defaults to `http.token`).

### Added — M0 foundation

- Host bundle skeleton: `package.json`, `cordis.patch.yml`, config defaults and
  validation for the full technical-design schema.
- `WatchStore`: one writer per run (cross-process directory lock), hash-chained
  `watch.jsonl`, crash-tail truncation, corruption detection, size cap.
- Pure signal rules for budget, failure streak, stall and context pressure.
- Decision validation, authorization matrix (observe/guard/supervised),
  evidence requirements and idempotency keys.
- Executor with dry serial queue, intent/executed/verified records, recovery of
  interrupted actions.
- Swarm, pressure and fishkeeper HTTP ports; fishkeeper is read-only and honest
  about browser-only authentication.
- Loopback read API with same-origin and write-token enforcement.
- M0 probe: a real DSH profile with a scripted provider verifies A-1, A-2, A-3,
  A-4, A-5, A-7, A-8, A-9, the slot model, and the signal→case→wake→decide→
  execute→verify loop.
- 29 unit tests, including a six-process lock race and tail-repair/tamper cases.

### Verified

- DSH `0.2.2-rc.3` on Windows; see `docs/spike-m0.md` and
  `e2e/m0/results/`.
