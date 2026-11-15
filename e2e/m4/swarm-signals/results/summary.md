# Real dsh-swarm I-5/I-6/I-7

- mode: real dsh-swarm service + real git worktrees/reviews/merges; scripted worker edits (no model calls)
- swarm: `C:\Users\11403\Desktop\em\dsh-swarm`
- at: 2026-11-15T05:26:56.011Z

| scenario | pass | case | detection | real events | note |
| --- | --- | --- | --- | --- | --- |
| I-5 | PASS | review_deadlock | 1370ms | review=1 votes=0 gateFail=0 conflicts=0 merged=0 | task=reviewing reviewers=1 votes=0 case=review_deadlock |
| I-6 | PASS | gate_pingpong | 310ms | review=3 votes=3 gateFail=3 conflicts=0 merged=0 | gateFailures=3 task=working cycles=GATE_FAILED,GATE_FAILED,GATE_FAILED case=gate_pingpong |
| I-7 | PASS | conflict_storm | 307ms | review=4 votes=4 gateFail=0 conflicts=3 merged=1 | conflicts=3 merged=1 firstMerge=d38b5820 case=conflict_storm |

Each scenario runs the real `SwarmService` against a real git repository: real task market, real review state, real worktrees, real gate commands and real merges. Worker edits are scripted so no model tokens are spent.
