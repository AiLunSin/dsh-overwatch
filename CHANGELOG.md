# Changelog

All notable changes are recorded here. The project follows SemVer once it
publishes; until then the minor version tracks milestones.

## [Unreleased]

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
