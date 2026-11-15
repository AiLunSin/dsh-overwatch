# dsh-overwatch（瞭望塔）

> 给 DeepSeek Harness 的受控蜂群加两层监管：**无模型的硬闸门（Guard）** + **受工具限制的值班员（Watch）**，再配一本**跨源证据账**（独立 `watch.jsonl` 哈希链）。
>
> 一句话记忆点：**模型可以判，不能动手；硬闸门不靠模型；没有证据不动作。**

**状态：M0–M4 发布候选（值班员 experimental；真实模型单次唤醒、真实 Edge 恢复演练
与 GitHub Release 已验证；完整 A/B/C 与 npm 发布仍受外部条件阻塞）。** 仓库包含 Host + Web 面板、
真实 DSH 0.2.2-rc.3 上的 M0/M1/M2/M3 探针、8 个事故场景回归、混沌/安全用例、
一次真实 DeepSeek 模型的值班员唤醒，以及 scoped 发布产物。
`supervised` 编队会在第一个 L2+ 事件单到来时懒启动一个**只能看案情卡和取证据**的
子代理；它提交结构化决定，由代码校验、执行、验证并记账。硬限（预算 80/95/100%、
事件流缺口）始终由确定性 Guard 执行，不经过模型。

---

## 1. 现在有什么

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `src/config.js` | ✅ | 技术方案默认值 + 校验（含 `ports.origin/swarmToken`、`supervisor.agentPreset`、`policy.throttleMinutes`、`autopilot.pauseOnHardLimit`） |
| `src/util.js` | ✅ | 规范化 JSON、哈希链、跨进程目录锁、原子写、脱敏 |
| `src/store.js` | ✅ | `watch.jsonl` 单写者 + 哈希链；崩溃尾部截断；篡改检测；只读归档 |
| `src/probe.js` | ✅ | 三源采样、事件游标、缺口锁存、新鲜度、退避、成员→子会话映射 |
| `src/signals.js` | ✅ | 预算四档/失败连击/停滞/上下文压力/事件缺口纯函数 |
| `src/cases.js` | ✅ | 事件单 key/冷却/双 tick/升级/重开/物化视图 |
| `src/guard.js` | ✅ | 无模型硬规则：throttle、hard pause、abort、log integrity |
| `src/watch.js` | ✅ M2 | 值班员生命周期：懒启动、冷恢复唤醒、三工具注册、超时/预算/代际 |
| `src/card.js` | ✅ M2 | ≤8KB 案情卡、按引用取证据、按严重度限定动作 |
| `src/fish-index.js` | ✅ M3 | 只读 fishkeeper 检查点索引/manifest/audit 尾部；不读 blob |
| `src/policy.js` | ✅ | 决定/guard plan 校验、授权矩阵、置信度门槛、幂等键 |
| `src/executor.js` | ✅ | 校验→授权→执行→验证→记账；串行、幂等、崩溃恢复 |
| `src/run.js` | ✅ | 每 run 状态机、锁、采样、Guard+Watch 调度、disarm 归档与交接班 |
| `src/service.js` | ✅ | 多 run 注册、arm/disarm、历史归档、agent/created 与 usage 转发 |
| `src/tools.js` | ✅ | 根 agent 的 `watch_arm/disarm/status/report` |
| `src/http.js` | ✅ | `/overwatch/api/*` 只读 API + 受 token 保护的 arm/disarm/ack/close/resume/purge/approvals/restores；doctor |
| `src/approvals.js` | ✅ | 持久 approve 队列：一次性令牌、TTL、去重、生命周期事件 |
| `client.js` | ✅ M3 | 值班室、事件单（close）、鱼缸（检查点/恢复）、回放时间轴、doctor、resume/purge/approve 按钮 |
| 发布产物 | ✅ M4 | scoped 构建、目录/tarball 安装冒烟、CI；npm 发布待 OTP |
| 真实模型 | ✅ 单次 / ⛔ A/B | 值班员单次唤醒 9,958 tokens PASS；完整 A/B/C 见 docs/m4.md |

### 两层如何分工

| 条件 | 动作 | 执行者 |
| --- | --- | --- |
| 预算 ≥ 80% / ≥95% / ≥100% | throttle（10 分钟后自动 resume）/ pause / abort | Guard（无模型） |
| 墙钟 ≥ `thresholds.maxRunMs`（默认 8h） | abort | Guard |
| 事件流缺口或日志损坏 | abort | Guard |
| swarm 源不可用/过期 | 只记录 source_unavailable，暂停确定性动作与模型变更 | Guard + policy |
| L2+ 事件单 | 懒启动值班员，读案情卡 + ≤3 次证据，提交 `notice/coach/throttle/pause/escalate` | Watch + Executor |
| 软信号持续 `policy.resolveMs` 不出现 | 案件自动 resolve | CaseManager |
| 操作员 ack/close/resume/purge | 通过受 token 保护的 HTTP；ack 会使在途决定失效，purge 需 `PURGE <runId>` 确认 | Human |
| `requiresHuman` 决定/计划 | 持久入队 → 人工 challenge 取一次性令牌 → approve 后原样重放执行 | Human + Executor |
| 值班员超时/崩溃 2 次 | 降级为 guard-only，写 `watch/degraded` | Supervisor |
| 值班员 token 达到预留 R | 不再唤醒，Guard 继续 | Supervisor |
| 成员失败连击 / 上下文压力 / 停滞 | 开 L2/L1 事件单 | 确定性信号 |

`autopilot.pause` 只控制**值班员**的暂停建议；硬闸门用独立的
`autopilot.pauseOnHardLimit`。值班员的工具表只有 `watch_case`、`watch_evidence`、
`watch_decide`：`restrict` 在串行 `agent/created` 监听里同步施加，冷恢复时幂等重施。

### M3 鱼缸 / 回放 / 恢复

- **鱼缸**：Host 只读 `~/.dsh/fishkeeper`（`fish.dataDir` 可覆盖）的检查点索引、
  manifest 摘要与 audit 尾部；面板同时走 fishkeeper 浏览器面（存在时）展示完整状态。
- **恢复**：面板执行 fishkeeper 的 dryRun 预检 → 展示 files/warnings → 二次确认 →
  执行；overwatch 只记录 `watch/restore/intent|result`，**拒绝任何 confirmToken**。
- **回放**：`/runs/:id/timeline` 合并 swarm、pressure 采样与 watch 事件；
  游标 `nextSince` 不透明，按 `(at, sourceRank, seq)` 固定顺序。
- **doctor**：`/overwatch/api/doctor` 检查数据目录、服务链、上游、写 token、
  鱼缸索引、每 run 锁/链/值班员与磁盘。
- 鱼缸自动检查点/恢复仍不落 Host：fishkeeper 写路由只在浏览器面，Host fetch 401。

---

## 2. 安装（本地目录）

```powershell
# 建议先使用临时 profile 与独立 DSH_HOME，不要直接动主力 profile
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile headless --dump-config
dsh plugin --profile ow add C:\Users\11403\Desktop\overwatch
```

Web 面板需要 web profile；装好后侧边栏出现「瞭望塔」，
`GET http://127.0.0.1:<port>/overwatch/api/health` 返回版本、模式、链校验与源状态。

配置在 profile 的 `cordis.patch.yml` 中按行 id 覆盖（完整示例
[examples/profile-patch.yml](./examples/profile-patch.yml)）：

```yaml
- id: dsh-overwatch
  config:
    mode: guard
    http:
      token: change-me         # 空 = 写接口禁用；supervised 编队需要 token
    ports:
      swarmToken: change-me    # 空 = 复用 http.token；必须与 swarm 的 http.token 一致
      origin: ''               # 空 = Host web server；headless/外部可用 http://127.0.0.1:PORT
    fish:
      dataDir: ''              # 空 = ~/.dsh/fishkeeper（fishkeeper 默认）
    supervisor:
      reserveRatio: 0.05       # R = clamp(B * ratio, 0, min(maxReserve, B*0.2))
      wakeTimeoutMs: 90000
      maxWakesPerHour: 6
    policy:
      autopilot:
        pauseOnHardLimit: true
```

---

## 3. 使用

```js
// 根 agent：supervised 需要本会话的根 agent 作为值班员 parent
watch_arm({ runId: 'swarm_xxx', mode: 'supervised' })
watch_status({ runId: 'swarm_xxx' })
watch_report({ runId: 'swarm_xxx' })
watch_disarm({ runId: 'swarm_xxx', reason: '收工' })
```

- `supervised` 的前置检查：swarm 可达、运行 running/paused、`http.token` 非空、
  根 agent 存在、`非蜂后成员数 + 1 ≤ maxActiveSubagents`。不满足会返回
  `CAPACITY_CONFLICT` / `AGENT_REQUIRED` / `WRITE_DISABLED` 等明确错误。
- 通过 HTTP 只能 arm `guard/observe`（HTTP 没有 agent 树）；`supervised` 必须由
  根 agent 的工具调用发起。
- 值班员第一次唤醒就是第一个 L2+ 事件单；之后同一 child 用 `sendMessage`
  冷恢复，不需要常驻子代理槽。

HTTP 只读接口：

```powershell
curl http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx
curl 'http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/cases?state=open'
curl 'http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/timeline?since=0'
curl http://127.0.0.1:PORT/overwatch/api/fish
curl http://127.0.0.1:PORT/overwatch/api/doctor
```

写接口需 `x-overwatch-token`：arm/disarm/ack/close/resume/purge/approvals/restores。面板会展示值班员状态、
唤醒次数、S/R token、超时和子会话，并区分 guard-only / supervised 横幅；
鱼缸页展示检查点/审计与恢复流程，回放页展示合并时间轴。

### 人工批准队列

`requiresHuman` 不再直接拒绝，而是把决定/guard plan 写入
`<run>/approvals/<id>.json` 并记 `watch/approval/requested`。批准分两步：

```powershell
# 1) 读取待批准项（只读）
curl 'http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/approvals?state=pending'
# 2) 取一次性令牌（写 token）；令牌只返回一次，服务端只存 SHA-256
curl -X POST -H "x-overwatch-token: $env:OW_TOKEN" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/approvals/apv_xxx/challenge
# 3) 批准并执行；令牌单次有效，默认 5 分钟过期
curl -X POST -H "x-overwatch-token: $env:OW_TOKEN" -H 'content-type: application/json' \
  -d '{"token":"<one-time>","note":"..."}' \
  http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/approvals/apv_xxx/approve
# 或拒绝
curl -X POST -H "x-overwatch-token: $env:OW_TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"not now"}' http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/approvals/apv_xxx/reject
```

- 同样的 pending 请求按幂等键去重，不会因每个 tick 重复入队。
- 人工批准**不能**越过 `observe`；模型决定在 `guard` 下也不能被人工批准（只有确定性
  guard 可动作）。`guard`/`supervised` 下人工批准的 guard plan 可执行。
- 执行走同一个 `Executor`，账本带 `approvedBy: "human"` 与 `approvalId`，并写
  `watch/approval/executed|failed`；重复批准返回冲突。
- 队列有 TTL（`policy.approvalTtlMs`，默认 1 小时），过期写 `watch/approval/expired`。

### 链完整性与存储硬化

- 设置 `OVERWATCH_CHAIN_KEY` 后所有新事件用 HMAC-SHA256 链；事件带
  `alg: "hmac-sha256"`，无密钥读取 HMAC 链会失败（`EHMACKEY`），从 HMAC
  降级到普通哈希会被拒绝（`EALG`）。
- 外部锚点 `<dataDir>/anchors/<runId>.jsonl` 每 64 次追加与 close 时写入，
  `doctor` 会用已验证事件比对最新锚点，能发现截断/重写。
- 目录 `0700`、文件 `0600`；`watch.jsonl` 与锁文件拒绝 symlink（`ESYMLINK` /
  `ELOCKSYMLINK`）；接管陈旧锁时重读被移动的 owner nonce，避免 TOCTOU。
- `storage.retentionDays` 现在会自动扫描：服务打开时与每 6 小时清理一次，只删
  已归档、未加锁、链完好且超过保留期的 run；删除前先写
  `watch/service/retention` tombstone。

---

## 4. 验证

```powershell
npm test        # 164 个测试：链/锁/场景/信号/事件单/Guard/Watch/卡/鱼缸/执行器/批准队列/HTTP/服务/面板
npm run lint    # node --check 64 个源文件
npm run m0      # M0 能力探针（真实 DSH，脚本化 provider）
npm run m1      # M1/M3 web 端到端（33/33）
npm run m2      # M2 值班员 headless 端到端（12/12）
npm run m4:real # 一次真实模型值班员唤醒（需账号凭据；token 上限 80k）
npm run build:release   # scoped 发布副本
npm run smoke:install   # 目录安装冒烟（tarball 见 docs/m4.md）
```

沙箱/CI 无法 spawn 子进程时：`node --test --test-isolation=none "test/*.test.js"`。

- M0 证据：`e2e/m0/results/`；结论 [docs/spike-m0.md](./docs/spike-m0.md)。
- M1 证据：`e2e/m1/results/`；结论 [docs/m1.md](./docs/m1.md)。
- M2 证据：`e2e/m2/results/`；结论 [docs/m2.md](./docs/m2.md)。
- M3 证据：`e2e/m1/results/`（33 项含 doctor/fish/timeline/restore）；
  结论 [docs/m3.md](./docs/m3.md)。
- M4 硬化与发布：[docs/m4.md](./docs/m4.md)。

配置、兼容与排障：[docs/config.md](./docs/config.md)、
[docs/compatibility.md](./docs/compatibility.md)、
[docs/troubleshooting.md](./docs/troubleshooting.md)。

M2 真实宿主结果（脚本化 provider + 进程内假 swarm）：值班员 4 次模型请求的工具表
始终只有三件套、`watch_decide(coach)` 被执行并写入 `steer`、S=26160/50000 tokens、
case `mitigated`、交接班 `shift-0001`、13 条 watch 哈希链全连续。

---

## 5. 设计边界（不要过度承诺）

- **完整模型 A/B/C 未做**：已用 2 元预算验证**一次**真实值班员唤醒
  （9,958 tokens，`coach` 0.82 被执行器接受）；三组 ×3 场景的对比需要更多预算与
  真实 swarm，不能把单次唤醒当成质量结论。
- **教练不保证送达**：`coach`/`throttle` 的文本只写 swarm `steer` 事件，上游不投递
  成员 inbox；v1 文案必须写"可能不送达"。
- **墙钟/新鲜度**：`thresholds.maxRunMs` 默认 8 小时，0 表示关闭；`sampling.staleMs`
  过期后 guard 不再执行预算类动作，值班员只能 notice/escalate。
- **暂停需要人工恢复**：`pause` 不再自动 resume；操作员可用
  `POST /overwatch/api/runs/:id/resume`（需写 token），面板写操作区在运行 paused/被
  throttle 时提供「恢复运行」按钮。`throttle` 只在"由我们暂停"时按到期自动 resume。
- **人工批准不等于放行一切**：批准队列只重放原始决定/计划；`observe` 永不执行，
  `guard` 下模型决定仍被拒绝。一次性令牌只在 challenge 响应中出现一次。
- **"0 超支"以监管层存活为前提**：总支出上界是 `B + S`（S ≤ 5% × B）。
- **值班员只做判断**：不写代码、不合并、不修 bug；没有 swarm/fs/bash/subagent 工具。
- **鱼数据自动检查点/恢复仍是 P1**：fishkeeper 写路由只在浏览器面，Host fetch 401；
  面板的浏览器恢复流程已实现，并且 M4 已用真实 Edge 走通恢复/键盘/AX 验收。
- **回放时间轴**只合并有 `at` 的 swarm/pressure/watch 条目；fishkeeper 的日记审计
  在鱼缸页单独展示，未强绑到 run。
- **面板的浏览器验收**见 M4 的 Edge 恢复/键盘/AX 结果；HTTP 面另有端到端。
- **fake swarm 不是 dsh-swarm**：M1/M2 e2e 只验证 overwatch 的读写契约。

---

## 6. 目录

```text
overwatch/
├── src/                 # Host 半（Guard + Watch + Evidence + 鱼缸索引）
├── client.js            # Web 面板（值班室 + 事件单 + 鱼缸 + 回放）
├── e2e/m0/              # M0 能力探针与结果
├── e2e/m1/              # M1/M3 假 swarm + web 探针 + 结果
├── e2e/m2/              # M2 进程内假 swarm + 脚本化 provider + headless runner + 结果
├── test/                # 单元/路由/服务/装配/面板测试
├── docs/                # spike-m0.md、m1.md、m2.md、m3.md、DETAIL.md
├── cordis.patch.yml     # 组合包 patch 层
└── scripts/             # 语法检查入口
```

上游项目：

- `github.com/AiLunSin/dsh-pressure`（压力表）
- `github.com/AiLunSin/dsh-swarm`（蜂群）
- `github.com/AiLunSin/fish-keeper-console`（养鱼人控制台）

设计文档（需求单、技术方案、架构图）在项目工作区的 `lianhe/` 目录，未随本仓库发布。

---

## 7. License

MIT
