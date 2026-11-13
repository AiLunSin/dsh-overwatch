# M2 值班员真实宿主演进验证

这是 M2（`mode=supervised`）的 headless 真实 DSH 验证。它不模拟 agent 运行时：

- 真实 Desktop DSH headless profile；
- 真实 subagent 服务：值班员是 `delivery:'caller'`、`maxDepth:1` 的子代理；
- 真实串行 `agent/created` 限制：子代理工具表只有三件套；
- 真实工具管线与 Executor；
- 进程内假 swarm HTTP 服务（`e2e/m2/harness`）接收 `intervene(steer)`；
- 脚本化 provider（`e2e/m2/fake-llm`）扮演根 agent 与值班员，不调用真实模型。

## 运行

```powershell
npm run m2          # 12 个 check，全 pass → 0
node e2e/m2/run.mjs --keep
```

需要打包版 Desktop DSH（`DSH_DESKTOP_ROOT` 可覆盖默认
`%LOCALAPPDATA%\Programs\DeepSeek Harness`）。不需要模型账号/网络/费用。

## 场景

1. 根 agent `watch_arm(swarm_m2, mode=supervised)`。
2. 假 swarm 预算 0.81 → 两个 500ms tick 后 `budget_pressure` L2 单。
3. Supervisor 懒启动值班员，卡片作为初始 prompt。
4. 值班员 `watch_case` → `watch_evidence` → `watch_decide(coach, 0.82)`。
5. Executor 写入假 swarm `steer` 并验证；事件单 `mitigated`。
6. 根 agent 等 3.5s 后 `watch_disarm`；写 `shift-0001`。

## 12 个 check

`run-exit` / `chain-ok` / `armed-supervised` / `case-opened` / `wake-recorded` /
`watch-decision` / `action-chain` / `swarm-steer` / `watch-tools-only` /
`usage-accounted` / `case-closed` / `shift-written`。

`watch-tools-only` 检查值班员每次模型请求的工具表恰好是
`watch_case`、`watch_evidence`、`watch_decide`，且没有 `bash/write/subagent/swarm_*`。

## 发布物

```text
e2e/m2/results/
├── report.json                 # checks + 13 条 watch 事件 + 工具表
├── summary.json                # gate、DSH 版本、耗时
├── watch.jsonl                 # 真实 run 的哈希链
├── calls.json                  # 假 swarm 收到的 steer
├── llm.jsonl                   # 每次模型请求的工具表
├── shift-0001.md               # 交接班
├── profile-cordis.patch.yml
└── run.log
```

## 边界

- 脚本化 provider 只验证管线/限制/预算/记录，不验证判断质量。
- 假 swarm 只实现 overwatch 用到的契约。
- 冷恢复（第二案 `sendMessage`）由 `test/watch.test.js` 覆盖；真实宿主上只跑了首案。
- headless 没有 webServer，因此 profile 用 `ports.origin` 指向进程内假 swarm。
