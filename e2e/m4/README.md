# M4 real-model watch probe

One **real** DeepSeek account watch wake, with a scripted root so only the watch
child costs tokens.

```powershell
cd C:\Users\11403\Desktop\overwatch
npm run m4:real                  # reasoning=off, 80k token / 200s probe budget
npm run m4:real -- --reasoning low
```

What it does:

1. Creates a throwaway `DSH_HOME` and copies the current
   `$DSH_HOME/.credentials.yaml` into it. The file is never printed or published.
2. Creates a headless profile from the default headless template, mounts
   `dsh-credentials-local`, `dsh-authorization`, `dsh-deepseek-account`, the
   fake swarm, the M2 harness and a scripted root provider.
3. The root fake calls `watch_arm`, waits for the watch log to show a decision,
   then calls `watch_disarm`.
4. The watch child is routed by `supervisor.agentOptions` to
   `deepseek-account/deepseek-flash` with `reasoningEffort: off` and
   `maxTokens: 2048`.
5. The runner stops at 80k watch tokens or 200s and records:

```text
e2e/m4/results/report.json
e2e/m4/results/watch.jsonl
e2e/m4/results/calls.json
e2e/m4/results/llm.jsonl
e2e/m4/results/run.log
e2e/m4/results/summary.json
```

Checks: chain, supervised arm, real route, case, one wake, decision, action
chain, token cap, disarm.

## Result (2026-11-14)

- `coach`, confidence 0.82, accepted, action `act_40077aa4487e`
- 3 model calls / 9,958 tokens / 11.7 s
- 9/9 checks pass; real model used `watch_case`, `watch_evidence`, `watch_decide`

The real model exposed three bugs that are now fixed: `[object Object]` evidence
ids, missing `target.kind` enum/hints, and rejected decisions not recording
validation errors.

## Boundaries

- This is **one wake**, not an A/B/C benchmark and not evidence of better
  judgment than guard-only.
- It uses the user's real account credentials in a temporary home; run it only
  when you accept the (small) model charge.
- The synthetic case is a budget-pressure card; real swarm market/review/merge
  behavior is not exercised.
