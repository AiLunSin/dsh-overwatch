# dsh-overwatch 详情

## 它解决什么

多 agent 并行时，真正难的不是"再派一个 agent 去盯着"，而是三件事：

1. **硬边界必须不依赖模型**：预算到 95% 该暂停、100% 该中止、日志坏了该停——这些不能等模型判断。
2. **软判断需要上下文**：为什么卡住、该教练还是该暂停、证据够不够——这些值得让一个受限制的 agent 线程来看。
3. **事后要能还原**：判断、动作、验证必须各有一条记录，且能被独立校验。

dsh-overwatch 把这三件事拆成 Guard / Watch / Evidence 三层，叠加在
dsh-swarm（运行事实）、dsh-pressure（token 读数）、fish-keeper-console（审计）
之上，不改写三个上游。

## 当前版本（0.1.0，M0–M4 发布候选）

**M1 硬闸门（guard-only 也完整可用）**：

- 四个根 agent 工具：`watch_arm` / `watch_disarm` / `watch_status` / `watch_report`
- 每 run 单写者 + 哈希链 `watch.jsonl`；崩溃尾部修复、篡改检测、只读归档
- 采样器：swarm 事件游标 / 快照 / pressure 活跃成员 / 鱼缸概览；缺口锁存、退避、新鲜度
- 事件单：确定性 key、15 分钟冷却、L2 双 tick、升级/重开、物化视图
- Guard：80% throttle（到期自动 resume）、95% 硬 pause、100% abort、
  事件流缺口 abort；无 case / 无 token / 冷却 / 自动干预上限时只记 notice
- Executor：校验 → 授权 → 幂等 → 执行 → 验证 → 记账；重启恢复
- 只读 API + token/同源保护的 arm/disarm/ack；Web 面板（值班室 + 事件单）

**M2 值班员（experimental）**：

- `mode: supervised` 时，第一个 L2+ 事件单懒启动一个 `delivery:'caller'`、
  `maxDepth:1` 的子代理；同一 run 内用 `sendMessage` 冷恢复，不常驻槽位
- 串行 `agent/created` 里同步 `restrict` 掉全部全局工具，只注册
  `watch_case` / `watch_evidence` / `watch_decide`
- 案情卡 ≤8KB；证据按 ref 取，≤8KB/次、≤3 次/案；决定必须带证据和 confidence
- Policy/Executor 二次校验：case/generation/childId/action/参数/证据/置信度/预算/冷却
- 超时、连续失败降级、token 预留 R、maxWakes/每小时限制、交接班 `watch/shift`
- 面板显示值班员 state/wakes/timeouts/S/R/child，并区分 guard-only / supervised
- 真实 DSH 端到端：`npm run m2`（12/12），见 `docs/m2.md`

**M3 鱼缸 / 回放 / 恢复（Host/API 完成，浏览器恢复待验收）**：

- 只读 fishkeeper 数据目录（检查点索引、manifest 摘要、audit 尾部）；不读 blob
- `GET /overwatch/api/fish`、`/fish/:sourceId`；`config.fish.dataDir` 可覆盖默认
  `~/.dsh/fishkeeper`
- 合并时间轴：swarm + pressure 采样 + watch，`(at, sourceRank, seq)` 排序，
  `nextSince` 不透明游标
- `GET /overwatch/api/doctor`：数据目录/服务链/上游/token/鱼缸索引/每 run/磁盘
- `POST /runs/:id/restores`：只记录 intent/result，**拒绝 confirmToken**
- 面板：鱼缸索引与恢复流程（dryRun→确认→执行→记账）、回放页、doctor 卡
- 真实 DSH 端到端：`npm run m1`（33/33，含 M3 检查），见 `docs/m3.md`

**未实现（M4 外部条件）**：真实模型 A/B（需要凭据与费用）、真实浏览器 fishkeeper
恢复演练、npm 发布（需要 OTP）、GitHub Release（仓库没有 remote）。
fishkeeper 自动检查点仍为 P1。

## 用法（5 分钟）

```powershell
# 1. 临时 profile 试装（不要直接动主力 profile）
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile headless --dump-config
dsh plugin --profile ow add C:\Users\11403\Desktop\overwatch

# 2. 在 profile 的 cordis.patch.yml 里配 write token
#    （见 examples/profile-patch.yml；swarm 的 http.token 要与 ports.swarmToken 一致）

# 3. 根 agent 里：
#    watch_arm(runId="swarm_xxx", mode="supervised")
#    watch_status(...); watch_report(...); watch_disarm(...)
```

`supervised` 需要：根 agent（作为 parent）、`http.token`、swarm 可达、
`非蜂后成员数 + 1 ≤ maxActiveSubagents`。HTTP arm 只能 `guard/observe`。
没有 `http.token` 时 guard arm 会降级为 `observe` 并写
`watch/guard/notice:write_disabled`；supervised 直接拒绝。

## 健康检查

```http
GET /overwatch/api/health
```

返回版本、模式、服务日志校验、每个 run 的状态/链校验/新鲜度/值班员状态，以及
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
    ├── shifts/shift-0001.md    # 交接班
    ├── snapshots/last.json     # 最近快照
    └── watch-<runId>.lock/     # 单写者锁
```

- 只记录判断、动作、验证与稳定 code；payload 写入前脱敏，单条 ≤16KB
- 不记录 prompt、工具参数正文、上游载荷、凭据
- 首事件 `prev: genesis`；中段损坏明确报错，不静默丢弃

## 验证

```powershell
npm test     # 124 个测试
npm run m0   # M0 能力探针（真实 DSH，脚本化 provider）
npm run m1   # M1/M3 web 端到端（33/33）
npm run m2   # M2 值班员 headless 端到端（12/12）
```

沙箱/CI 里无法 spawn 子进程时，用 `node --test --test-isolation=none "test/*.test.js"`。

## 限制

- **M2 判断质量未验证**：端到端用脚本化 provider；真实模型的误动作率/成本 A/B 是 M4 门槛。
- 教练/节流只保证写到 watch 日志与 swarm `steer` 事件；成员 inbox 投递要等
  上游 message 路由（P1）。
- `pause` 需人工 resume；`throttle` 只对"由我们暂停"的运行自动恢复。
- 自动鱼数据检查点需要浏览器凭据，v1 不做（P1）；面板只读展示。
- 面板的 fishkeeper 恢复流程需要浏览器认证；**真实恢复演练未验收**（本环境没有可
  自动化的浏览器）。overwatch 永不接收/存储 confirmToken。
- swarm 写 token 与 overwatch 写 token 需一致（或显式 `ports.swarmToken`）。
- 监管层崩溃时总支出上界是 `B + S`（S ≤ 5% × B），不宣称"监管崩溃也零超支"。
- 面板没有真实浏览器自动化验收；M0 已记录 headless Edge 在本机会挂起。
