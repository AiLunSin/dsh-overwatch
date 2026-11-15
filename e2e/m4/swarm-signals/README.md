# Real dsh-swarm I-5 / I-6 / I-7

The deterministic signal tests in `test/scenarios.test.js` feed synthetic event
arrays to the supervisor. This runner closes the next gap: it drives the **real
`dsh-swarm` service** and verifies that overwatch opens the same cases from a
real task market, real review state, real git worktrees, real gate commands and
real merge conflicts.

```powershell
cd C:\Users\11403\Desktop\overwatch
npm run m4:swarm
# or one scenario:
node e2e/m4/swarm-signals/run.mjs --scenario I-5 --keep
```

No model calls are made. Worker edits are scripted directly into each task's
worktree, so the probe is free, fast and deterministic while every coordination
step is real. Overwatch runs in `guard` mode against the real `/swarm/api`
surface; autopilot is disabled so the probe measures detection only.

## Scenarios

| id | real injection | expected |
| --- | --- | --- |
| I-5 | patch submitted, real review opened, nobody votes | `review_deadlock` L2 case after the 1s window |
| I-6 | failing `node -e "process.exit(1)"` gate; three submit/review/merge cycles on one task | `gate_pingpong` L2 after 3 real gate failures |
| I-7 | four parallel tasks add `src/shared.js`; one merge wins, three real merges conflict | `conflict_storm` L2 after 3 conflicts |

## Evidence (2026-11-15)

- `review_deadlock` detected after 1,370ms; task left in `reviewing`, 0 votes.
- `gate_pingpong` detected after 310ms; 3 real `GATE_FAILED` cycles, task `working`.
- `conflict_storm` detected after 307ms; 1 real merge commit, 3 real
  `MERGE_CONFLICT` events on `src/shared.js`.
- All three hash chains verify (`parseChain` clean).

Output:

```text
e2e/m4/swarm-signals/results/report.json
e2e/m4/swarm-signals/results/summary.md
e2e/m4/swarm-signals/results/I-5/{watch.jsonl,swarm-events.jsonl,cases/}
e2e/m4/swarm-signals/results/I-6/...
e2e/m4/swarm-signals/results/I-7/...
```

## Boundaries

- This is a real coordination run, not a real-model judgment run: no LLM is in
  the loop and the workers' edits are scripted.
- It does not replace the A/B/C watch-officer comparison (`npm run m4:abc`) or
  the single real wake (`npm run m4:real`).
