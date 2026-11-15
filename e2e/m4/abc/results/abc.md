# A/B/C supervision comparison

- groups: A, B · scenarios: I-1, I-3, I-4 · repeats: 1
- swarm: real local dsh-swarm (C:\Users\11403\Desktop\em\dsh-swarm) with scripted hanging runner (no model calls)
- pressure: scripted per fake member child
- watch cost: 0 (cap ¥20)

| group | scenario | # | detection | case | actions | final | ratio | wake tokens | pass | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | I-1 | 1 | - | - | - | running | 1.020 | - | PASS | baseline: no supervision, status=running, ratio=1.020 |
| A | I-3 | 1 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-4 | 1 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| B | I-1 | 1 | 208ms | budget_pressure | throttle|abort | aborted | 1.020 | - | PASS | status=aborted ratio=1.020 detection=208ms actions=throttle|abort |
| B | I-3 | 1 | 203ms | failure_streak | - | running | 0.000 | - | PASS | detection=203ms case=failure_streak actions=none |
| B | I-4 | 1 | 12187ms | stalled_dispatch | - | running | 0.000 | - | PASS | detection=12187ms case=stalled_dispatch actions=none |

> Group A runs without overwatch. Group B uses the in-process deterministic guard. Group C runs the real headless host with the real `deepseek-account/deepseek-flash` watch officer; its autopilot soft actions are disabled so the comparison measures the watch judgment, while the 1.00 hard abort stays deterministic.
