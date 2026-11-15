# Changelog

All notable changes are recorded here. The project follows SemVer once it
publishes; until then the minor version tracks milestones.

## [1.0.1] - 2026-11-15

### Added — full A/B/C supervision run

- `e2e/m4/abc` now runs the complete A/B/C comparison against a real local
  dsh-swarm: C uses the real DSH Desktop host and a real
  `deepseek-account/deepseek-flash` watch officer (reasoning off, maxTokens
  2048); swarm members and pressure are scripted so only the watch wake costs
  tokens.
- Result (2026-11-15): 27/27 PASS over I-1/I-3/I-4 ×3 repeats; 9 C wakes used
  135,346 tokens (about ¥2.1655 at the runner's upper-bound price); C produced
  `abort`, `coach` and `notice` decisions. Evidence under
  `e2e/m4/abc/results/`.

### Added — real dsh-swarm I-5/I-6/I-7

- New `e2e/m4/swarm-signals` runner drives the real `SwarmService`, real task
  market, review state, git worktrees, gate commands and merge conflicts, then
  checks the real overwatch probe/case path.
- Result: `review_deadlock` (1,370ms), `gate_pingpong` (310ms) and
  `conflict_storm` (307ms) all PASS; one real merge and three real conflicts.
  Evidence under `e2e/m4/swarm-signals/results/`.

### Added — DSH plugin listing

- Localized `meta.title` / `meta.description` now state the supervision
  capability, data read, model-token use in supervised mode, and what disabling
  the plugin does.
- The plugin detail page is a single feature image:
  `docs/DETAIL.md`, `docs/DETAIL.zh.md` and `docs/preview.svg`; the old long
  overview is no longer referenced by `meta.detail`.
- Installed `@ailunsin/dsh-overwatch@1.0.1` into the local `desktop` profile as a
  bundle (temporary `dist` link). `watch_status` reports 1.0.1 / guard, and
  `GET /overwatch/api/health` returns 200; the Web panel still needs a page
  refresh for visual verification.

### Added — OTP release helper

- `scripts/publish-otp.ps1` checks the npm identity and existing versions,
  bumps the version, builds and smoke-installs the scoped package, then asks
  for the 6-digit OTP locally and publishes. `@ailunsin/dsh-overwatch@1.0.0`
  was already published on 2026-11-14; this helper targets the M4.1 `1.0.1`
  release.

### Added — human approval queue and panel actions

- `ApprovalQueue` (`src/approvals.js`): `requiresHuman` decisions and guard plans
  are persisted under `<run>/approvals/<id>.json` instead of being dropped, with
  idempotent pending dedupe and lifecycle events
  `watch/approval/requested|challenged|approved|rejected|executed|failed|expired`.
- Two-step approval: `challenge` mints a high-entropy one-time token whose
  SHA-256 (bound to the approval id) is stored, never the plaintext; `approve`
  consumes it with `timingSafeEqual` and replays the stored decision/plan through
  the same `Executor` with `approvedBy: "human"` and `approvalId`.
- Human approval never crosses `observe` and cannot approve model decisions in
  `guard`; `policy.approvalTtlMs` (default 1h) bounds pending records, and
  challenge tokens expire after 5 minutes.
- HTTP: `GET /runs/:id/approvals`, `GET /runs/:id/approvals/:approvalId`, and
  token-protected `challenge`/`approve`/`reject`.
- Panel: close-case section (reason select), resume and purge buttons (with
  explicit `PURGE <runId>` confirmation), and a pending-approvals list with
  approve/reject and expiry. Restore-result recording now uses `keepalive` and no
  abort signal so an unload cannot cancel it.
- Table/dialog a11y: case titles are real buttons with `aria-haspopup="dialog"`
  and action-specific labels; the case drawer is `aria-labelledby` its heading;
  approval buttons name the action and case.

### Added — chain and storage hardening

- Optional `OVERWATCH_CHAIN_KEY` switches new events to HMAC-SHA256
  (`alg: "hmac-sha256"`); keyless reads fail (`EHMACKEY`) and HMAC→plain
  downgrade is rejected (`EALG`).
- External anchors at `<dataDir>/anchors/<runId>.jsonl` are written every 64
  appends and on close; `verifyAnchor`/`doctor` detect truncation or rewrites.
- Owner-only `0700` directories and `0600` files; `watch.jsonl` and lock files
  refuse symlinks (`ESYMLINK` / `ELOCKSYMLINK`); stale-lock takeover re-reads the
  moved owner nonce to close the TOCTOU window.
- `storage.retentionDays` now drives an automatic sweep on service open and every
  6 hours, purging only archived, unlocked, chain-valid runs older than the
  cutoff and writing `watch/service/retention` before deletion.

### Fixed — supervision hardening

- The watch officer now fails closed when its child cannot be proven to have
  only `watch_case`/`watch_evidence`/`watch_decide`; a restriction failure
  disposes the activation and degrades to the deterministic guard.
- Decisions are bound to the supervised run: `target.id`/`params.runId` cannot
  point at another run, and the swarm port uses executor context, not model
  params. Throttle minutes, coach text and target ids are bounded.
- `watch.jsonl` tail repair now uses byte offsets and physical line numbers;
  torn CJK tails, mid-file corruption without a final newline, and a complete
  last line missing its newline are handled without losing committed evidence.
- Executor recovery rebuilds idempotency outcomes, marks incomplete actions
  `unknown`, and prevents replay after restart.
- Added wall-clock hard abort (`thresholds.maxRunMs`), stale-source gating,
  `source_unavailable` cases, automatic soft-case resolution, human case close,
  human resume, explicit tombstoned purge, and acknowledgement generation bumps.
- Removed the undefined `summar` debug path; unrelated `agent/created` events
  are now metadata-only and never store prompts, headers or options.
- Hardened card/evidence byte caps, upstream redirect handling, HTTP Host
  validation, malformed percent-encoding handling and release `--out` guards.
- Case materialized files and snapshots now use the same scrub rules as the
  hash-chained log.

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
