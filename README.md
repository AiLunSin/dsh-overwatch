# dsh-overwatch（瞭望塔）

> 给 DeepSeek Harness 的受控蜂群加两层监管：**无模型的硬闸门（Guard）** + **受工具限制的值班员（Watch）**，再配一本**跨源证据账**（独立 `watch.jsonl` 哈希链）。
>
> 一句话记忆点：**模型可以判，不能动手；硬闸门不靠模型；没有证据不动作。**

**状态：M2 值班员完成（experimental），M1 硬闸门是它的安全底座。** 仓库现在包含
Host + Web 面板、真实 DSH 0.2.2-rc.3 上的 M0/M1/M2 探针与证据。`supervised` 编队
会在第一个 L2+ 事件单到来时懒启动一个**只能看案情卡和取证据**的子代理；它提交
结构化决定，由代码校验、执行、验证并记账。硬限（预算 80/95/100%、事件流缺口）
始终由确定性 Guard 执行，不经过模型。

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
| `src/policy.js` | ✅ | 决定/guard plan 校验、授权矩阵、置信度门槛、幂等键 |
| `src/executor.js` | ✅ | 校验→授权→执行→验证→记账；串行、幂等、崩溃恢复 |
| `src/run.js` | ✅ | 每 run 状态机、锁、采样、Guard+Watch 调度、disarm 归档与交接班 |
| `src/service.js` | ✅ | 多 run 注册、arm/disarm、历史归档、agent/created 与 usage 转发 |
| `src/tools.js` | ✅ | 根 agent 的 `watch_arm/disarm/status/report` |
| `src/http.js` | ✅ | `/overwatch/api/*` 只读 API + 受 token 保护的 arm/disarm/ack |
| `client.js` | ✅ | Web 面板：值班室（含值班员状态）+ 事件单 |
| M3 鱼缸/回放、M4 基准发布 | ❌ | 下一步 |

### 两层如何分工

| 条件 | 动作 | 执行者 |
| --- | --- | --- |
| 预算 ≥ 80% / ≥95% / ≥100% | throttle（10 分钟后自动 resume）/ pause / abort | Guard（无模型） |
| swarm 事件 seq 缺口或日志损坏 | abort | Guard |
| L2+ 事件单 | 懒启动值班员，读案情卡 + ≤3 次证据，提交 `notice/coach/throttle/pause/escalate` | Watch + Executor |
| 值班员超时/崩溃 2 次 | 降级为 guard-only，写 `watch/degraded` | Supervisor |
| 值班员 token 达到预留 R | 不再唤醒，Guard 继续 | Supervisor |
| 成员失败连击 / 上下文压力 / 停滞 | 开 L2/L1 事件单 | 确定性信号 |

`autopilot.pause` 只控制**值班员**的暂停建议；硬闸门用独立的
`autopilot.pauseOnHardLimit`。值班员的工具表只有 `watch_case`、`watch_evidence`、
`watch_decide`：`restrict` 在串行 `agent/created` 监听里同步施加，冷恢复时幂等重施。

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
```

写接口需 `x-overwatch-token`：arm/disarm/ack。面板会展示值班员状态、唤醒次数、
S/R token、超时和子会话，并区分 guard-only / supervised 横幅。

---

## 4. 验证

```powershell
npm test        # 98 个测试：链/锁/信号/事件单/Guard/Watch/卡/执行器/HTTP/服务/面板
npm run lint    # node --check 48 个源文件
npm run m0      # M0 能力探针（真实 DSH，脚本化 provider）
npm run m1      # M1 硬闸门 web 端到端（25/25）
npm run m2      # M2 值班员 headless 端到端（12/12）
```

沙箱/CI 无法 spawn 子进程时：`node --test --test-isolation=none "test/*.test.js"`。

- M0 证据：`e2e/m0/results/`；结论 [docs/spike-m0.md](./docs/spike-m0.md)。
- M1 证据：`e2e/m1/results/`；结论 [docs/m1.md](./docs/m1.md)。
- M2 证据：`e2e/m2/results/`；结论 [docs/m2.md](./docs/m2.md)。

M2 真实宿主结果（脚本化 provider + 进程内假 swarm）：值班员 4 次模型请求的工具表
始终只有三件套、`watch_decide(coach)` 被执行并写入 `steer`、S=26160/50000 tokens、
case `mitigated`、交接班 `shift-0001`、13 条 watch 哈希链全连续。

---

## 5. 设计边界（不要过度承诺）

- **没有真实模型 A/B**：M2 的管线与限制用脚本化 provider 验证；判断质量、误动作率、
  5% 预算是否够要 M4 用真实模型跑 3 个场景对比 guard-only。
- **教练不保证送达**：`coach`/`throttle` 的文本只写 swarm `steer` 事件，上游不投递
  成员 inbox；v1 文案必须写"可能不送达"。
- **M1/M2 不自动恢复**：`pause` 需人工 resume；`throttle` 只在"由我们暂停"时按
  到期 resume。没有"人类 resume"HTTP 路由（M3 面板动作）。
- **"0 超支"以监管层存活为前提**：总支出上界是 `B + S`（S ≤ 5% × B）。
- **值班员只做判断**：不写代码、不合并、不修 bug；没有 swarm/fs/bash/subagent 工具。
- **鱼数据检查点/恢复**仍为 P1：需要浏览器凭据或新 Host 路由。
- **面板未做真实浏览器自动化验收**（headless Edge 在本机会挂起）；HTTP 面有端到端。
- **fake swarm 不是 dsh-swarm**：M1/M2 e2e 只验证 overwatch 的读写契约。

---

## 6. 目录

```text
overwatch/
├── src/                 # Host 半（Guard + Watch + Evidence）
├── client.js            # Web 面板（值班室 + 事件单）
├── e2e/m0/              # M0 能力探针与结果
├── e2e/m1/              # M1 假 swarm + web 探针 + 结果
├── e2e/m2/              # M2 进程内假 swarm + 脚本化 provider + headless runner + 结果
├── test/                # 单元/路由/服务/装配/面板测试
├── docs/                # spike-m0.md、m1.md、m2.md、DETAIL.md
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
