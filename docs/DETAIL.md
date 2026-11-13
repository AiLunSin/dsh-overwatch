# dsh-overwatch 详情

## 它解决什么

多 agent 并行时，真正难的不是"再派一个 agent 去盯着"，而是三件事：

1. **硬边界必须不依赖模型**：预算到 95% 该暂停、100% 该中止、日志坏了该停——这些不能等模型判断。
2. **软判断需要上下文**：为什么卡住、该教练还是该暂停、证据够不够——这些值得让一个受限制的 agent 线程来看。
3. **事后要能还原**：判断、动作、验证必须各有一条记录，且能被独立校验。

dsh-overwatch 把这三件事拆成 Guard / Watch / Evidence 三层，叠加在
dsh-swarm（运行事实）、dsh-pressure（token 读数）、fish-keeper-console（审计）
之上，不改写三个上游。

## 当前版本（0.1.0，M1：硬闸门）

**已实现（guard-only）**：

- `watch_arm` / `watch_disarm` / `watch_status` / `watch_report` 四个根 agent 工具
- 每 run 单写者 + 哈希链 `watch.jsonl`（崩溃尾部修复、篡改检测）
- 采样器：swarm 事件游标 / 快照（5s）/ pressure 活跃成员（3s）/ 鱼缸概览（15s），
  失败退避、事件缺口锁存、源新鲜度
- 事件单：确定性 key、15 分钟冷却、L2 双 tick 规则、升级/重开、物化视图
- 硬闸门：预算 80% 软暂停（10 分钟自动恢复）、95% 暂停（不自动恢复）、
  100% 中止；swarm 事件缺口/日志损坏 → 立即中止
- 执行器：校验 → 授权 → 幂等 → 执行 → 验证 → 记账；重启恢复未完成动作
- 只读 API（runs / 快照 / 事件单 / 时间轴 / 交接班）+ 受 token 保护的 arm/disarm/ack
- Web 面板：值班室（运行、预算、新鲜度、事件单计数）+ 事件单（列表/详情/时间线/接管）

**未实现（M2+）**：值班员 agent 线程（`mode: supervised` 会被显式拒绝）、
教练/steer 的成员投递、鱼数据自动检查点、恢复执行、A/B/C 基准。

## 用法（5 分钟）

```powershell
# 1. 临时 profile 试装（不要直接动主力 profile）
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile headless --dump-config
dsh plugin --profile ow add C:\Users\11403\Desktop\overwatch

# 2. 在 profile 的 cordis.patch.yml 里给行配 write token
#    （见 examples/profile-patch.yml；swarm 的 http.token 要与 ports.swarmToken 一致）

# 3. 在会话里让根 agent 调工具，或走 HTTP：
#    watch_arm(runId="swarm_xxx", mode="guard")
```

`watch_arm` 的拒绝是显式的：`SWARM_UNAVAILABLE` / `RUN_NOT_RUNNING` /
`ALREADY_ARMED` / `SUPERVISOR_UNAVAILABLE`。没有 `http.token` 时 arm 会降级成
`observe` 并在 watch 日志里写 `watch/guard/notice:write_disabled`——不会假装在看。

## 健康检查

```http
GET /overwatch/api/health
```

返回版本、模式、服务日志校验、每个 run 的状态/链校验/新鲜度，以及
`swarm/pressure/fish` Port 能力。`/overwatch/api/runs`、`/runs/:id`、
`/runs/:id/cases`、`/runs/:id/timeline` 为只读；写接口（arm/disarm/ack）
要求 `x-overwatch-token` 且拒绝跨源。

## 数据

```text
$DSH_HOME/overwatch/
├── watch.jsonl                 # 服务自身生命周期（哈希链）
├── index.json                  # 本次实例 arm 的运行
└── runs/<runId>/
    ├── watch.jsonl             # 判断与动作，哈希链
    ├── cases/<caseId>.json     # 物化视图（可从日志重建）
    ├── snapshots/last.json     # 最近快照
    └── watch-<runId>.lock/     # 单写者锁
```

- 只记录判断、动作、验证与稳定 code；payload 写入前脱敏，单条 ≤16KB
- 不记录 prompt、工具参数正文、上游载荷、凭据
- 首事件 `prev: genesis`；中段损坏明确报错，不静默丢弃

## 验证

```powershell
npm test     # 单元 + 路由 + 服务/插件装配（node:test）
npm run m0   # M0 探针（临时 profile，脚本化 provider）
npm run m1   # M1 端到端（临时 web profile + 假 swarm，真实 Desktop DSH）
```

沙箱/CI 里无法 spawn 子进程时，用 `node --test --test-isolation=none "test/*.test.js"`。

## 限制

- **guard-only**：M1 没有值班员，只有确定性硬规则。"该教练还是该暂停"的判断留给 M2。
- 教练/节流只保证写到 watch 日志与 swarm `steer` 事件；成员 inbox 投递要等
  上游 message 路由（P1）。
- 自动鱼数据检查点需要浏览器凭据，v1 不做（P1）；面板只读展示。
- swarm 写 token 与 overwatch 写 token 需一致（或显式 `ports.swarmToken`）。
- 监管层崩溃时总支出上界是 `B + S`（S ≤ 5% × B），不宣称"监管崩溃也零超支"。
- 面板目前没有真实浏览器自动化验收；M0 已记录 headless Edge 在本机会挂起。
