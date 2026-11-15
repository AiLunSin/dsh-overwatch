# A/B/C supervision comparison

- groups: A, B, C · scenarios: I-1, I-3, I-4 · repeats: 3
- swarm: real local dsh-swarm (C:\Users\11403\Desktop\em\dsh-swarm) with scripted hanging runner (no model calls)
- pressure: scripted per fake member child
- stall thresholds: I-1=60000ms, I-3=60000ms, I-4=12000ms (I-1/I-3 disable the stall case so the tested signal owns the wake)
- watch cost: ¥2.1655 (cap ¥10)

| group | scenario | # | detection | case | actions | final | ratio | wake tokens | pass | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | I-1 | 1 | - | - | - | running | 1.020 | - | PASS | baseline: no supervision, status=running, ratio=1.020 |
| A | I-1 | 2 | - | - | - | running | 1.020 | - | PASS | baseline: no supervision, status=running, ratio=1.020 |
| A | I-1 | 3 | - | - | - | running | 1.020 | - | PASS | baseline: no supervision, status=running, ratio=1.020 |
| A | I-3 | 1 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-3 | 2 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-3 | 3 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-4 | 1 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-4 | 2 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| A | I-4 | 3 | - | - | - | running | 0.000 | - | PASS | baseline: no supervision, status=running, ratio=0.000 |
| B | I-1 | 1 | 206ms | budget_pressure | throttle|abort | aborted | 1.020 | - | PASS | status=aborted ratio=1.020 detection=206ms actions=throttle|abort |
| B | I-1 | 2 | 221ms | budget_pressure | throttle|abort | aborted | 1.020 | - | PASS | status=aborted ratio=1.020 detection=221ms actions=throttle|abort |
| B | I-1 | 3 | 19ms | budget_pressure | throttle|abort | aborted | 1.020 | - | PASS | status=aborted ratio=1.020 detection=19ms actions=throttle|abort |
| B | I-3 | 1 | 239ms | failure_streak | - | running | 0.000 | - | PASS | detection=239ms case=failure_streak actions=none |
| B | I-3 | 2 | 204ms | failure_streak | - | running | 0.000 | - | PASS | detection=204ms case=failure_streak actions=none |
| B | I-3 | 3 | 204ms | failure_streak | - | running | 0.000 | - | PASS | detection=204ms case=failure_streak actions=none |
| B | I-4 | 1 | 12190ms | stalled_dispatch | - | running | 0.000 | - | PASS | detection=12190ms case=stalled_dispatch actions=none |
| B | I-4 | 2 | 12197ms | stalled_dispatch | - | running | 0.000 | - | PASS | detection=12197ms case=stalled_dispatch actions=none |
| B | I-4 | 3 | 12221ms | stalled_dispatch | - | running | 0.000 | - | PASS | detection=12221ms case=stalled_dispatch actions=none |
| C | I-1 | 1 | 347ms | budget_pressure | abort | aborted | 1.020 | 17313 | PASS | status=aborted ratio=1.020 detection=347ms actions=abort |
| C | I-1 | 2 | 374ms | budget_pressure | abort | aborted | 1.020 | 17356 | PASS | status=aborted ratio=1.020 detection=374ms actions=abort |
| C | I-1 | 3 | 391ms | budget_pressure | abort | aborted | 1.020 | 17023 | PASS | status=aborted ratio=1.020 detection=391ms actions=abort |
| C | I-3 | 1 | 314ms | failure_streak | coach | running | 0.000 | 17913 | PASS | detection=314ms case=failure_streak actions=coach |
| C | I-3 | 2 | 314ms | failure_streak | coach | running | 0.000 | 7405 | PASS | detection=314ms case=failure_streak actions=coach |
| C | I-3 | 3 | 344ms | failure_streak | coach | running | 0.000 | 7521 | PASS | detection=344ms case=failure_streak actions=coach |
| C | I-4 | 1 | 9855ms | stalled_dispatch | notice | running | 0.000 | 16899 | PASS | detection=9855ms case=stalled_dispatch actions=notice |
| C | I-4 | 2 | 9862ms | stalled_dispatch | notice | running | 0.000 | 17199 | PASS | detection=9862ms case=stalled_dispatch actions=notice |
| C | I-4 | 3 | 9798ms | stalled_dispatch | notice | running | 0.000 | 16717 | PASS | detection=9798ms case=stalled_dispatch actions=notice |

> Group A runs without overwatch. Group B uses the in-process deterministic guard. Group C runs the real headless host with the real `deepseek-account/deepseek-flash` watch officer; its autopilot soft actions are disabled so the comparison measures the watch judgment, while the 1.00 hard abort stays deterministic.
