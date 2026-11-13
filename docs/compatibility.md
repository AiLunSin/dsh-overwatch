# Compatibility

## Tested baseline

| Item | Tested value |
| --- | --- |
| DeepSeek Harness | `0.2.2-rc.3` |
| Runtime | Electron Node `24.21` (Desktop) |
| OS | Windows 11 26300 x64 |
| Node (tests/tools) | Node 22/24/26; `engines.node >= 22` |
| dsh-pressure | `0.1.0` contract (optional) |
| dsh-swarm | `0.1.1` contract (optional) |
| fishkeeper | `0.1.1` data layout (optional) |

The bundle declares `engines.dsh >=0.2.2-rc.3 <0.3.0`. It imports no
`@deepseek-ai/*` package and uses only public Host services (`tools`,
`webServer`, `subagents`, `agents`, `session/event`, `agent/created`), so a
minor DSH release should not break loading; run `npm run m0/m1/m2` when
upgrading.

## Degradation matrix

| Capability | Missing upstream | Behavior |
| --- | --- | --- |
| swarm | no run / health | arm fails `SWARM_UNAVAILABLE`; no supervision |
| pressure | 404/absent | `pressure` freshness unavailable; context/failure signals stay silent |
| fishkeeper | 401/absent | Host index may still work from `fish.dataDir`; write/restore stays browser-only |
| subagents | no service | `supervised` arm rejects `SUBAGENTS_UNAVAILABLE`; guard still works |
| webServer | headless without `ports.origin` | arm rejects `WEB_UNAVAILABLE` |
| write token | empty | writes disabled; guard arm downgrades to `observe`; supervised rejects |

## DSH version drift

The following are runtime assumptions verified in M0/M1/M2 and are the first
things to re-check on a DSH upgrade:

1. `agent/created` is serial and awaits listeners before the first model request.
2. `agent.ctx.tools.restrict({deny})` plus scoped `register` is the only way to
   build the watch tool table.
3. `delivery: 'caller'` children settle and cold-resume through `sendMessage`.
4. A child can be started with a reserved `childId`; this is how the watch
   officer is claimed before its catalog name is published.
5. The Host Web server has **no** server-wide origin/token policy; every route
   owner must enforce its own.

## Known deviations from the technical plan

| ID | Plan | Reality | Handling |
| --- | --- | --- | --- |
| D-M0-1 | `tools.schemas(agent.ctx)` | scope is the Agent object | `schemas(agent)` |
| D-M0-2 | watch `maxDepth: 0` | child depth is parent+1 | `maxDepth: 1` + restrict removes `subagent` |
| D-M0-3 | watch officer resident | caller children are not resident | per-case wake + cold resume |
| D-M0-4 | routes ready at start | webServer mounts later | `ctx.inject(['webServer'])` + 404 retry |
| D-M1-1 | `autopilot.pause` gates pause | guard needs its own switch | `pauseOnHardLimit` |
| D-M1-2 | budget_pressure L1 | signals implement L2 | documented; L2 is the case/action tier |
| D-M2-1 | name-based child claim | `namesOf` unavailable during `agent/created` | reserved `childId` |
| D-M3-1 | fish data at `$DSH_HOME/fishkeeper` | fishkeeper defaults to `~/.dsh/fishkeeper` | `fish.dataDir` override |
| D-M3-2 | fish restore from Host | routes are browser-authenticated | browser flow + evidence recording only |

## Windows notes

File modes are best-effort; overwatch does not claim POSIX `0700/0600`. Atomic
JSON writes retry `rename` on `EPERM/EBUSY` (a reader can hold the target open)
and fall back to a direct write.
