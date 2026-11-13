# dsh-overwatch M1 真实宿主端到端验证

这是 M1（arm + 采样 + 硬闸门 + pause/abort + 只读 API + 证据链）的**真实 Desktop DSH Web 宿主**验证骨架。它不模拟 HTTP：`dsh-overwatch`、fake swarm、probe 都作为真实 DSH 插件行装进一次性 profile，由真实的 `ctx.webServer` 提供路由，probe 用真实 HTTP 请求驱动，最后读取真实 `watch.jsonl` 并独立校验哈希链。

> M0（headless + web 的能力探测）见 `e2e/m0/`。M1 只跑 Web：headless 没有 Host web server。

## 前置条件

- Windows + 打包版 Desktop DSH（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`；可用 `DSH_DESKTOP_ROOT` 指向包含 `DeepSeek Harness.exe` 的目录）。
- Node.js ≥ 22（只用于 runner 自身的进程管理；DSH 使用安装包内的 Electron/Node）。
- 不需要模型账号、网络或 token 花费：profile 里没有真实 provider，也没有真实 swarm。

## 运行

```powershell
# 推荐
npm run m1

# 等价的直接调用
node e2e/m1/run.mjs

# 保留临时 profile/home 便于排查（会打印路径）
node e2e/m1/run.mjs --keep
```

退出码：**0 = 报告里每个 check 都是 `pass` 且 probe 正常结束；1 = 任一 check 失败、缺少报告或 setup 失败**。证据固定发布到 `e2e/m1/results/`。

## 本地无 DSH 自检

不启动 Desktop 也能先验证一半：

```powershell
node --check e2e/m1/fake-swarm/index.js
node --check e2e/m1/probe/index.js
node --check e2e/m1/run.mjs
node e2e/m1/test-fake-swarm.mjs
```

`test-fake-swarm.mjs` 会起一个 127.0.0.1 HTTP 服务，挂上 fake swarm 的真实 handler，覆盖健康检查、snapshot/events、token/origin 拒绝、pause/resume/steer/abort、预算控制面、seq 单调和 dispose。它不需要 DSH，也不会写文件。真正的宿主端到端仍然只能由 `npm run m1` 完成。

## 它实际做了什么

1. 在系统临时目录创建一次性 `DSH_HOME`，用 `dsh --profile m1web --from-default-profile web --dump-config` 生成 Web profile。
2. 把三个本地包装进 profile 并设为 bundles：
   - `dsh-overwatch`（被测实现，来自本仓库根目录）
   - `dsh-overwatch-m1-fake-swarm`（`e2e/m1/fake-swarm`）
   - `dsh-overwatch-m1-probe`（`e2e/m1/probe`）
3. 覆盖 profile 的 `cordis.patch.yml`：
   - `dsh-overwatch`：`mode: guard`、`http.token: m1-token`、`ports.swarmToken: m1-swarm-token`、采样全部 500ms、`staleMs: 5000`、`policy.autopilot.throttle: false`、`policy.throttleMinutes: 1`，thresholds 保持默认（0.80 / 0.95）。
   - `dsh-overwatch-m1-fake-swarm`：`token: m1-swarm-token`。
4. 启动真实 Web host（`--port 0 --no-open`），等 probe 把 `finishedAt` 写进报告，最多 120s；随后 `taskkill /T /F` 杀掉整棵进程树。
5. 发布 `report.json`、`summary.json`、`watch.jsonl`、`profile-cordis.patch.yml`、`run.log`。

> **测试 token 说明**：M1 的 `SwarmPort` 用 `ports.swarmToken`（为空时才回退到 `http.token`）作为上游 swarm 写 token。本 profile 显式把它设成 `m1-swarm-token`，与 fake swarm 的配置一致；`http.token: m1-token` 只用于 probe 调 overwatch 写接口。这两个都是测试值，不是秘密。

## 场景与 check

fake swarm 初始状态为 `running`，预算 25%；probe 通过 loopback 测试控制面 `POST /fake/api/budget` 改预算：

| 阶段 | fake 预算 | 期望 |
| --- | --- | --- |
| arm | — | 无 token 401、错 token 401、跨源+正确 token 403、正确 token 200、重复 arm 409 |
| L2 | 0.81 | 2 个采样周期后出现 `budget_pressure` L2 事件单；`autopilot.throttle=false`，所以**不产生 throttle 动作** |
| L3 | 0.96 | 出现 `budget_pause` L3 事件单；fake swarm 收到 `action: "pause"`；运行快照 `status=paused`；watch 日志出现 pause 的 intended → executed → verified |
| L4 | 1.01 | 出现 `budget_exhausted` L4 事件单；fake swarm 收到 `action: "abort"`；运行快照 `status=aborted`；watch 日志出现 abort 的 intended → executed → verified |
| disarm | — | `POST disarm` 200；再次 `GET /overwatch/api/runs/swarm_m1` 仍 200 且 `armed:false, state:"disarmed"`；所有未决单 `state:"closed", closeReason:"abandoned"`；再次 disarm 404/409 |

probe 的 check 共 25 项：

| check | 含义 |
| --- | --- |
| `health` / `swarm-health` | `/overwatch/api/health`、`/swarm/api/health` 在 20s 内 200（插件行可能早于服务挂载，404 会重试） |
| `arm-no-token` / `arm-wrong-token` | 写接口缺 token / 错 token 返回 401 |
| `arm-cross-origin` | 正确 token 但 `Origin: https://evil.example` 返回 403 |
| `arm-ok` / `arm-duplicate` | 正确 token、`mode=guard` 返回 200 且 `data.armed=true`；第二次 arm 返回 409 |
| `budget-pressure-case` | 0.81 后出现 `budget_pressure` L2 单 |
| `budget-pressure-no-action` | fake swarm 没有收到 throttle/steer/pause/abort，watch 日志也没有 `watch/action/intended`；这是预期而非失败 |
| `budget-pause-case` | 0.96 后出现 `budget_pause` L3 单 |
| `budget-pause-call` | fake swarm 记录到 `action:"pause"` 且 HTTP 200 |
| `budget-pause-run` | overwatch 运行快照 `status=paused` |
| `budget-pause-watch` | watch 日志中 pause 的 intended/executed/verified 顺序正确 |
| `budget-exhausted-case` | 1.01 后出现 `budget_exhausted` L4 单 |
| `budget-exhausted-call` | fake swarm 记录到 `action:"abort"` 且 HTTP 200 |
| `budget-exhausted-run` | overwatch 运行快照 `status=aborted` |
| `budget-exhausted-watch` | watch 日志中 abort 的 intended/executed/verified 顺序正确 |
| `disarm` | `POST disarm` 200，返回 `runId`、`closedCases`（若实现返回 `state` 必须是 `disarmed`） |
| `disarm-run` | disarm 后运行快照仍可读，`armed=false`、`state=disarmed`、`disarmedAt` 非空 |
| `disarm-cases` | disarm 前所有未决单都变成 `closed` 且 `closeReason="abandoned"`，并出现在 `closedCases` 中（若 disarm 时已无未决单则记录为通过） |
| `disarm-again` | 第二次 disarm 返回 404 或 409（记录具体值） |
| `watch-chain` | 对 `watch.jsonl` 逐行重算 `hash = sha256(prev + "\n" + canonicalJson(body))`，seq/prev/hash 全部连续 |
| `watch-types` | 事件类型至少包含 `watch/armed`、`watch/case/opened`、`watch/action/intended`、`watch/action/executed`、`watch/action/verified`、`watch/case/closed`、`watch/disarmed` |
| `watch-pause-chain` / `watch-abort-chain` | 最终日志里 pause / abort 的动作链仍完整且顺序正确 |

## 报告结构

`e2e/m1/results/report.json`：

```json
{
  "schemaVersion": 1,
  "stage": "web",
  "startedAt": "...",
  "checks": { "health": { "status": "pass", "evidence": {}, "at": "..." } },
  "http": { "arm-no-token": { "method": "POST", "path": "...", "status": 401, "expected": [401], "tokenSent": false, "body": {} } },
  "cases": [ { "phase": "L2", "id": "case_...", "code": "budget_pressure", "severity": "L2", "signals": [], "actions": [], "view": {} } ],
  "watch": { "path": "...", "chainOk": true, "events": [], "types": [] },
  "gate": { "ok": true, "failed": [] },
  "errors": [],
  "finishedAt": "..."
}
```

`finishedAt` 只在最后一步写入；runner 把 `finishedAt !== null` 视为“probe 已完成”。`http` 只记录具名请求，不记录任何 token 原文（只记录 `tokenSent: true/false`）。`summary.json` 是 runner 的发布摘要（版本、耗时、每个 check 状态、gate、发布文件）。

## 发布物

```text
e2e/m1/results/
├── report.json                 # probe 报告
├── summary.json                # runner 摘要 + gate
├── watch.jsonl                 # 真实 $DSH_HOME/overwatch/runs/swarm_m1/watch.jsonl
├── profile-cordis.patch.yml    # 本次 profile 覆盖（含固定测试 token）
├── profile-package.json        # 本次 profile manifest（bundles 列表）
└── run.log                     # Web host stdout/stderr（token 已脱敏）
```

若存在多个 watch 文件（例如重跑或不同 run），其余文件会以 `watch-<相对路径>.jsonl` 发布。

## 边界与已知限制

- fake swarm **不是** dsh-swarm：它只实现 overwatch M1 读取/写入的字段和 endpoint；不要用它验证真实 swarm 的市场、评审、worktree 行为。
- 真实 Desktop DSH 无法在当前沙箱里启动；本目录内的 `node --check` 和 `test-fake-swarm.mjs` 是不依赖 DSH 的本地验证。真实端到端由宿主上的 `npm run m1` 完成。
- `OVERWATCH_M1_DATA` 指向 `$DSH_HOME/overwatch`；probe 优先读 `runs/swarm_m1/watch.jsonl`，再兼容 M0 的平铺路径。
- 采样窗口是 500ms，probe 会等 ≥2 个周期；如果机器负载很高或实现改成更慢的采样，先看 `report.json` 的 `http` 和 `errors`，再调大 `CASE_WAIT_MS`。
- 测试只在 loopback 上运行；fake 控制面也只接受 loopback。

## 排查

| 现象 | 处理 |
| --- | --- |
| `cannot find the Desktop installation` | 设置 `DSH_DESKTOP_ROOT` 指向 `DeepSeek Harness.exe` 所在目录 |
| 120s 超时 | 看临时目录里的 `run.log`；Web host 可能没起来，或 probe 在等 404 的服务 |
| `health` 失败 | 确认 profile 里 `dsh-overwatch`、fake-swarm、probe 三个 bundles 都已激活；看 `run.log` 里的 `[overwatch]` / `[fake-swarm]` 日志 |
| pause/abort 没发生 | 确认预算比例真的被采样到（`budget.limits.runTokens` 与 `run.tokens`），以及 `http.token` 非空、fake token 匹配 |
| 报告里 `state` 不是 `paused`/`aborted` | 先看 fake swarm `/fake/api/state` 的 `calls`，再看 watch 日志 action 事件 |
