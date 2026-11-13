# Troubleshooting

## `watch_arm` fails

| Code | Meaning | Fix |
| --- | --- | --- |
| `SWARM_UNAVAILABLE` | swarm health or run read failed | start dsh-swarm in the same Host / check `ports.origin` |
| `RUN_NOT_FOUND` / `RUN_NOT_RUNNING` | run id typo or run ended | use a running/paused run |
| `ALREADY_ARMED` | this process already supervises the run | `watch_disarm` first; another process holding the lock also lands here |
| `WEB_UNAVAILABLE` | no web server origin and no `ports.origin` | use a web profile or set `ports.origin` |
| `WRITE_DISABLED` | `http.token` empty (supervised) | set a token; guard arms in `observe` without one |
| `AGENT_REQUIRED` | supervised arm has no root agent | call `watch_arm` from the root agent, not over HTTP |
| `CAPACITY_CONFLICT` | non-queen members + 1 > `maxActiveSubagents` | raise the capacity or remove a member before arming |
| `SUBAGENTS_UNAVAILABLE` | profile has no subagents service | use a headless/web template that mounts it |
| `SUPERVISOR_DISABLED` | `supervisor.enabled: false` | enable it, or use `guard` mode |
| `ELOCKED` | another writer owns `watch-<runId>.lock` | stop the other Host/session; a dead pid is taken over automatically |

## Panel / API

- **404 on every route**: the plugin row may run before the Host web server
  mounts. Reload after the server is up; check `[overwatch] active` in the log.
- **`/overwatch/api/fish` empty**: set `fish.dataDir` if fishkeeper uses a
  non-default data root; the default is `~/.dsh/fishkeeper`.
- **fishkeeper calls 401**: expected from the Host; fishkeeper writes need the
  browser connection. The panel degrades to the Host index.
- **doctor `fishkeeper-write: warn`**: same browser-authentication fact, not a
  broken install.
- **`RESTORE_TOKEN_REJECTED`**: the browser sent the fishkeeper `confirmToken`
  to overwatch. It must only be used against `/api/fishkeeper/checkpoint/restore`.
- **`WATCH_LOG_CORRUPT`**: the run chain failed verification (seq/prev/hash).
  The run becomes read-only; export the log and start a new arm. Do not hand-edit
  the JSONL.
- **history disappeared after restart**: history is read from
  `$DSH_HOME/overwatch/runs/<runId>/`; check the same `DSH_HOME`/`dataDir`.

## Watch officer

- `watch_timeout` / `watch/wake/timeout`: the child produced no `watch_decide`
  within `wakeTimeoutMs`. The case stays open and the guard keeps running; two
  consecutive failures write `watch/degraded`.
- Tools missing in the child: it was not restricted/attached. Check
  `watch/attach` / `watch/worker ignored` events and the DSH version assumptions
  in `compatibility.md`.
- `requires_human`: autopilot disallowed the action (for example `pause` with
  `autopilot.pause: false`); use the panel/ack or a human decision.

## Recovery

1. `GET /overwatch/api/doctor` and `watch_status`.
2. `watch_disarm(runId, reason)` — abandons open cases and writes a shift.
3. Re-arm. A held lock from a dead writer is taken over after the stale timeout;
   `ELOCKED` while the owner is alive is intentional.
4. Corrupt watch log: keep the directory for evidence, arm a fresh run id; never
   rewrite a committed chain.
