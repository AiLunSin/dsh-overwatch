# dsh-overwatch（瞭望塔）

> 给 DeepSeek Harness 的受控蜂群加两层监管：**无模型的硬闸门（Guard）** + **受工具限制的值班员（Watch）**，再配一本**跨源证据账**（独立 `watch.jsonl` 哈希链）。
>
> 一句话记忆点：**模型可以判，不能动手；硬闸门不靠模型；没有证据不动作。**

**状态：M1 硬闸门完成（guard-only），值班员属于 M2。** 本仓库现在包含可安装的
Host + Web 面板、真实 DSH 0.2.2-rc.3 上的 M0/M1 探针与证据。装上并 `watch_arm`
之后，它会采样 swarm/pressure/鱼缸、按确定性阈值开事件单，并在预算 80%/95%/100%
与事件流缺口上执行 throttle / pause / abort。

---

## 1. 现在有什么

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `src/config.js` | ✅ | 技术方案附录 A 默认值 + 校验（含 M1 的 `ports.swarmToken`、`policy.throttleMinutes`、`autopilot.pauseOnHardLimit`） |
| `src/util.js` | ✅ | 规范化 JSON、哈希链、跨进程目录锁、原子写、脱敏 |
| `src/store.js` | ✅ | `watch.jsonl` 单写者 + 哈希链；崩溃尾部截断；篡改检测；只读归档读取 |
| `src/probe.js` | ✅ | 三源采样、事件游标、缺口锁存、新鲜度、退避、成员→子会话映射 |
| `src/signals.js` | ✅ | 预算四档/失败连击/停滞/上下文压力/事件缺口纯函数 |
| `src/cases.js` | ✅ | 事件单 key/冷却/双 tick/升级/重开/物化视图 |
| `src/guard.js` | ✅ | 无模型硬规则：throttle、hard pause、abort、log integrity |
| `src/policy.js` | ✅ | 决定与 guard plan 的校验、授权矩阵、幂等键 |
| `src/executor.js` | ✅ | 校验→授权→执行→验证→记账；串行、幂等、崩溃恢复 |
| `src/run.js` | ✅ | 每 run 的状态机/锁/采样定时器/动作串行；disarm 归档 |
| `src/service.js` | ✅ | 多 run 注册、arm/disarm、历史归档读取、服务生命周期日志 |
| `src/tools.js` | ✅ | `watch_arm` / `watch_disarm` / `watch_status` / `watch_report`（根 agent 限定） |
| `src/http.js` | ✅ | `/overwatch/api/*` 只读 API + 受 token 保护的 arm/disarm/ack |
| `client.js` | ✅ | Web 面板：值班室 + 事件单（侧边栏 + main） |
| 值班员 agent 线程 | ❌ M2 | `mode: supervised` 在 M1 被显式拒绝 |
| 鱼缸自动检查点/恢复 | ❌ P1 | 宿主写接口不可达，面板只读展示 |

### M1 硬闸门行为

| 条件 | 动作 | 自动恢复 |
| --- | --- | --- |
| 预算 ≥ 80% | `throttle`：pause + 10 分钟后自动 resume | 是（可配 `throttleMinutes`） |
| 预算 ≥ 95% | `pause`（硬暂停） | 否，等人 |
| 预算 ≥ 100% | `abort` | 否 |
| swarm 事件 seq 缺口 / 日志损坏 | `abort`（`log_integrity` L4） | 否 |
| 成员工具失败 ≥3 / 上下文 ≥85% | 开 L2/L1 事件单，不动作 | — |

`autopilot.pause` 仍只控制**值班员**（M2）的暂停权限；硬闸门用独立的
`autopilot.pauseOnHardLimit` 开关，避免"开硬暂停就必须同时放开模型暂停"。

---

## 2. 安装（本地目录）

```powershell
# 建议先使用临时 profile 与独立 DSH_HOME，不要直接动主力 profile
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile headless --dump-config
dsh plugin --profile ow add C:\Users\11403\Desktop\overwatch
```

Web 面板需要 web profile；装好后侧边栏出现「瞭望塔」，同时
`GET http://127.0.0.1:<port>/overwatch/api/health` 返回版本、模式、链校验与源状态。

配置在 profile 的 `cordis.patch.yml` 中按行 id 覆盖（完整示例
[examples/profile-patch.yml](./examples/profile-patch.yml)）：

```yaml
- id: dsh-overwatch
  config:
    mode: guard
    http:
      token: change-me         # 空 = 写接口禁用，arm 降级 observe
    ports:
      swarmToken: change-me    # 空 = 复用 http.token；必须与 swarm 的 http.token 一致
    policy:
      throttleMinutes: 10
      autopilot:
        pauseOnHardLimit: true
```

> `watch_arm` 需要 Host web server 就绪（swarm 在同一个 Host 里）。headless
> profile 没有 webServer，arm 会返回 `WEB_UNAVAILABLE`，这是预期。

---

## 3. 使用

```js
// 根 agent
watch_arm({ runId: 'swarm_xxx', mode: 'guard' })
watch_status({ runId: 'swarm_xxx' })
watch_report({ runId: 'swarm_xxx' })
watch_disarm({ runId: 'swarm_xxx', reason: '收工' })
```

或走 HTTP（写接口需 `x-overwatch-token`）：

```powershell
curl -X POST http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/arm `
  -H 'content-type: application/json' -H 'x-overwatch-token: change-me' `
  -d '{"mode":"guard"}'
curl http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx
curl 'http://127.0.0.1:PORT/overwatch/api/runs/swarm_xxx/cases?state=open'
```

面板：值班室看运行/预算/新鲜度/未决单；事件单看 severity、signals、证据引用、
动作时间线，并可「确认接管（ack）」或 disarm。写操作需要先输入 token（只存
`sessionStorage`）。

---

## 4. 验证

```powershell
npm test        # 单元/路由/服务/装配测试
npm run lint    # node --check 全部源码
npm run m0      # M0 探针（真实 DSH，脚本化 provider，零模型费用）
npm run m1      # M1 端到端（临时 web profile + 假 swarm，真实 Desktop DSH）
```

沙箱/CI 无法 spawn 子进程时：

```powershell
node --test --test-isolation=none "test/*.test.js"
```

M0 证据在 `e2e/m0/results/`，M1 证据在 `e2e/m1/results/`（`report.json`、
`summary.json`、`watch-swarm_m1.jsonl`、profile patch 副本、运行日志）。

M0 结论（DSH 0.2.2-rc.3，Electron Node 24.21）：A-1/A-2/A-3/A-4/A-7/A-8/A-9
通过；fishkeeper 宿主读返回 401（浏览器面，P1）；`steer` 只落事件不投递 inbox。
详见 [docs/spike-m0.md](./docs/spike-m0.md)。

M1 结论与逐项证据见 [docs/m1.md](./docs/m1.md)。

---

## 5. 设计边界（不要过度承诺）

- **v1 的教练不保证送达**：dsh-swarm 0.1.1 的 `steer` 只写 `swarm/intervened`
  事件，不投递成员 inbox；coach/throttle 只能留痕。
- **M1 没有判断层**：只有确定性阈值；"该不该暂停"的软判断是 M2 值班员的事。
- **"0 超支"以监管层存活为前提**：监管层崩溃时仍有 swarm 自身预算兜底，但总支出
  上限是 `B + S`（`S ≤ 5% × B`）。
- **蜂后不占子代理槽**：8 成员 = 蜂后 + 7 工蜂；M1 不启动值班员，所以不占槽。
  M2 的 `supervised` arm 会按「非蜂后成员数 + 1」校验，8 成员时需调大
  `maxActiveSubagents` 或先移除成员。
- **鱼数据自动检查点不在 v1**：需要浏览器凭据或新 Host 路由；面板只读。
- **Windows 文件权限**：只做 best-effort，不宣称 0700/0600。
- **面板未做真实浏览器自动化验收**（headless Edge 在本机会挂起）；HTTP 面有端到端。

---

## 6. 目录

```text
overwatch/
├── src/                 # Host 半（M0 地基 + M1 硬闸门）
├── client.js            # Web 面板（值班室 + 事件单）
├── e2e/m0/              # M0 探针与结果
├── e2e/m1/              # M1 假 swarm + 探针 + runner + 结果
├── test/                # 单元/路由/服务/装配测试
├── docs/                # spike-m0.md、m1.md、DETAIL.md
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
