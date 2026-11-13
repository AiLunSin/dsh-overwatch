# Configuration

All keys are optional; defaults are applied by `src/config.js`. A profile patch
overrides the bundle row by id:

```yaml
- id: dsh-overwatch
  config:
    mode: guard
```

Unknown keys are ignored so an older bundle can read a newer profile; a known key
with a wrong type/range fails activation loudly.

## Top level

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` skips activation entirely |
| `mode` | `observe` \| `guard` \| `supervised` | `guard` | `supervised` arms the M2 watch officer |
| `dataDir` | string | `$DSH_HOME/overwatch` | resolved from `storage.dataDir` |

## `http`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | register `/overwatch/api/*` when the Web server mounts |
| `token` | string | `''` | empty disables writes; `supervised` requires a token |

Write routes also require loopback and (when a browser sends it) a same-origin
`Origin`. Reads need no token.

## `ports`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `swarmToken` | string | `''` | upstream `x-swarm-token`; empty falls back to `http.token` |
| `origin` | string | `''` | empty uses the Host Web server; useful for headless/CLI |

## `fish`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dataDir` | string | `''` | empty means fishkeeper's `~/.dsh/fishkeeper` (not `$DSH_HOME`) |

The Host only reads `checkpoints/<sourceId>/index.jsonl`,
`checkpoints/<sourceId>/<id>/manifest.json` and
`audit/<sourceId>.actions.jsonl`. No blob or diary content is read.

## `supervisor`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | false rejects `supervised` arm |
| `provider` | string | `spawn` | subagent provider |
| `model` | `inherit` \| `fast` \| `strong` | `inherit` | routed by the child preset |
| `agentPreset` | string | `''` | optional explicit child preset |
| `reserveRatio` | number 0–0.5 | `0.05` | `R = clamp(B*ratio, 0, min(maxReserve, 0.2B))` |
| `maxReserveTokens` | integer | `200000` | upper bound for R |
| `maxWakes` | integer | `30` | total wakes per run |
| `maxWakesPerHour` | integer | `6` | sliding-hour limit |
| `wakeTimeoutMs` | integer ≥1000 | `90000` | one wake may not exceed this |
| `maxEvidenceBytes` | integer ≥1024 | `8192` | per `watch_evidence` call |
| `maxEvidenceCalls` | integer ≥1 | `3` | per case |
| `maxTokensPerWake` | integer ≥1000 | `20000` | pre-wake estimate cap |

## `sampling`

| Key | Type | Default |
| --- | --- | --- |
| `swarmEventMs` | integer ≥100 | `1000` |
| `swarmSnapshotMs` | integer ≥100 | `5000` |
| `pressureMs` | integer ≥100 | `3000` |
| `fishMs` | integer ≥100 | `15000` |
| `staleMs` | integer ≥100 | `30000` |
| `requestTimeoutMs` | integer ≥100 | `3000` |
| `maxInflight` | integer ≥1 | `4` |

One timer per run drives all due sources; failures back off exponentially.

## `policy`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `cooldownMs` | integer ≥0 | `900000` | same case+action suppression |
| `maxAutoInterventions` | integer ≥0 | `5` | soft guard actions per run |
| `twoSignalRule` | boolean | `true` | L2 single signal needs two ticks |
| `throttleMinutes` | integer 1–60 | `10` | guard-resume window |
| `autopilot.throttle` | boolean | `true` | guard throttle switch |
| `autopilot.pause` | boolean | `false` | **watch officer** pause permission |
| `autopilot.pauseOnHardLimit` | boolean | `true` | deterministic guard pause switch |
| `autopilot.abortOnHardLimit` | boolean | `true` | abort at 100% |
| `autopilot.budgetAdjust` | boolean | `false` | reserved; human-only |
| `autopilot.restore` | boolean | `false` | reserved; human-only |

`pause` (watch) and `pauseOnHardLimit` (guard) are separate on purpose: enabling
the hard pause must not silently allow a model-driven pause.

## `thresholds`

| Key | Type | Default |
| --- | --- | --- |
| `contextPressure` | number 0–1 | `0.85` |
| `contextExit` | number 0–1 | `0.70` |
| `budgetPressure` | number 0–1 | `0.80` |
| `budgetPause` | number 0–1 | `0.95` |
| `failureStreak` | integer ≥1 | `3` |
| `gateFailures` | integer ≥1 | `3` |
| `conflictStorm` | integer ≥1 | `3` |
| `stallMs` | integer ≥1 | `600000` |
| `reviewDeadlockMs` | integer ≥1 | `900000` |
| `maxResultTokens` | integer ≥1 | `12000` |
| `maxOpenCases` | integer ≥1 | `20` |

`budgetPressure` must not exceed `budgetPause`; `contextExit` must not exceed
`contextPressure`.

## `storage`

| Key | Type | Default |
| --- | --- | --- |
| `dataDir` | string | `''` (`$DSH_HOME/overwatch`) |
| `retentionDays` | integer ≥1 | `90` |
| `maxBytesPerRun` | integer ≥1024 | `52428800` (50 MB) |
