# dsh-overwatch

> Supervised swarms for DeepSeek Harness: a **model-free hard guard** plus a **tool-restricted watch officer**, backed by an independent, hash-chained evidence log.
>
> Memory hook: **the model may judge but never act; hard limits never depend on a model; no evidence, no action.**

**Status: M0–M3 complete (watch officer experimental).** The bundle ships a Host
half and a Web panel, with real-DeepSeek-Harness 0.2.2-rc.3 probes for capability
(M0), guard-only supervision (M1), the watch officer (M2), and fish tank / replay
/ doctor / restore evidence (M3). M4 hardening is tracked in
[docs/m4.md](./docs/m4.md). The real-model A/B benchmark and npm publication
depend on external credentials/approval.

## What it does

| Layer | Responsibility |
| --- | --- |
| **Guard** | Deterministic, model-free: throttle at 80% budget, hard pause at 95%, abort at 100%, abort on a swarm event gap. |
| **Watch** | One lazy, tool-restricted child agent (`watch_case`, `watch_evidence`, `watch_decide`) for L2+ cases; it proposes, the executor validates/authorizes/acts/verifies. |
| **Evidence** | Per-run `watch.jsonl` with a SHA-256 chain, materialized cases, shift handover, restore intent/result records. |

The watch officer never sees `bash`, `write`, `subagent`, `swarm_*` or merge
tools. Restrictions are applied synchronously in the serial `agent/created`
listener and re-applied on cold resume.

## Install (local directory)

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile web --dump-config
dsh plugin --profile ow add C:\path\to\dsh-overwatch
```

The panel appears in the sidebar as “Overwatch”. `GET /overwatch/api/health`
reports version, mode, chain state and source freshness.

## Use

```js
// root agent
watch_arm({ runId: 'swarm_xxx', mode: 'supervised' })
watch_status({ runId: 'swarm_xxx' })
watch_report({ runId: 'swarm_xxx' })
watch_disarm({ runId: 'swarm_xxx', reason: 'done' })
```

`supervised` requires the root agent, a write token, and
`non-queen members + 1 <= maxActiveSubagents`. HTTP can arm only
`guard`/`observe` because it has no agent tree.

Key configuration (`examples/profile-patch.yml` has a full example):

```yaml
- id: dsh-overwatch
  config:
    mode: guard
    http: { token: change-me }
    ports: { swarmToken: change-me, origin: '' }
    fish: { dataDir: '' }          # default ~/.dsh/fishkeeper
    policy:
      autopilot: { pauseOnHardLimit: true, abortOnHardLimit: true }
```

## Verify

```powershell
npm test        # 124 tests incl. the eight incident scenarios
npm run lint
npm run m0      # capability probe
npm run m1      # M1/M3 web end-to-end (33 checks)
npm run m2      # M2 watch officer headless end-to-end (12 checks)
npm run build:release
npm run smoke:install
```

See [docs/m4.md](./docs/m4.md) for the hardening matrix and remaining
external gates (real-model A/B, browser restore drill, npm publish).

## Boundaries

- The watch officer's judgment quality is not yet measured with a real model.
- `coach`/`throttle` text is recorded as a swarm `steer` event; upstream does not
  guarantee delivery to a member inbox.
- `pause` needs a human resume; `throttle` resumes only when overwatch paused.
- Fish data checkpoints/restores run in the browser; the Host is read-only and
  never stores fishkeeper confirm tokens.
- Total spend can reach `B + S` (S ≤ 5% of B) if overwatch crashes.
- The panel has no automated real-browser acceptance yet.

## License

MIT
