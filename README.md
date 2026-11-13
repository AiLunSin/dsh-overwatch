# dsh-overwatch（瞭望塔）

> 给 DeepSeek Harness 的受控蜂群加两层监管：**无模型的硬闸门（Guard）** + **受工具限制的值班员（Watch）**，再配一本**跨源证据账**（独立 `watch.jsonl` 哈希链）。
>
> 一句话记忆点：**模型可以判，不能动手；硬闸门不靠模型；没有证据不动作。**

**状态：M0 技术验证完成，尚未发布，还不是可用插件。** 本仓库现在包含可安装的 Host 骨架、经过真实 DSH 0.2.2-rc.3 验证的 M0 探针、锁/哈希链原型与结论。仲裁、采样、值班员、面板属于 M1–M4，尚未实现（见 [docs/spike-m0.md](./docs/spike-m0.md)）。

---

## 1. 现在有什么

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `src/config.js` | ✅ | 技术方案附录 A 的完整默认值 + 校验 |
| `src/util.js` | ✅ | 规范化 JSON、哈希链、跨进程目录锁、原子写 |
| `src/store.js` | ✅ | `watch.jsonl` 单写者 + 哈希链；崩溃尾部截断；篡改检测 |
| `src/signals.js` | ✅ | 预算/连续失败/停滞/上下文压力纯函数信号 |
| `src/policy.js` | ✅ | 决定 schema 校验、L2+ 证据要求、授权矩阵、幂等键 |
| `src/executor.js` | ✅ | 校验→授权→执行→验证→记账，串行且幂等 |
| `src/ports/*` | ✅ | swarm（读 + intervene 写）、pressure（只读）、fish（只读） |
| `src/http.js` | ✅ | `/overwatch/api/health`、`/watch`、`/watch/verify`；本机 + 同源 + 写 token |
| `src/service.js` | ✅ | 运行目录、watch 日志生命周期、能力探测 |
| `client.js` / 面板 | ❌ | M3 |
| arm / 采样 / 信号开单 / 值班员 | ❌ | M1–M2 |

> 当前模式默认 `guard`，但没有 arm 和处置路径，所以**装上也只会写 `watch/armed` 与健康路由**；不会自动暂停或中止任何 run。

---

## 2. 安装（本地目录）

```powershell
# 建议先使用临时 profile 与独立 DSH_HOME，不要直接动主力 profile
$env:DSH_HOME = "$env:TEMP\dsh-overwatch-try"
dsh --profile ow --from-default-profile headless --dump-config
dsh plugin --profile ow add C:\Users\11403\Desktop\overwatch
```

之后 `GET http://127.0.0.1:<port>/overwatch/api/health` 应返回版本、模式、watch 日志校验结果。Web profile 下路由会在 `webServer` 就绪后自动注册（M0 实测：插件行可能早于 Host 服务挂载）。

配置在 profile 的 `cordis.patch.yml` 中按行 id 覆盖，例如：

```yaml
- id: dsh-overwatch
  config:
    mode: supervised
    policy:
      autopilot:
        pause: false
    http:
      token: change-me
```

---

## 3. 验证

```powershell
npm test        # 29 个单测：哈希链 / 锁（含 6 进程竞争）/ 校验 / 执行器 / HTTP / 信号 / 配置
npm run lint    # node --check 全部源码
npm run m0      # 抛一个临时 profile，跑真实 DSH 的 M0 探针（无模型、无费用）
```

`npm run m0` 需要本机安装 DeepSeek Harness Desktop（默认
`%LOCALAPPDATA%\Programs\DeepSeek Harness`，可用 `DSH_DESKTOP_ROOT` 覆盖），
会创建并删除临时 `DSH_HOME`；证据写到 `e2e/m0/results/`。

M0 结论摘要（DSH 0.2.2-rc.3，Electron Node 24.21）：

| 项 | 结论 |
| --- | --- |
| A-1 子代理工具限制 | ✅ `agent/created` 串行监听内 `agent.ctx.tools.restrict({deny:[...all]})`，子代理首个模型请求只剩 scoped 工具 |
| A-2 caller 子代理续聊 | ✅ 结果后子代理已不常驻，`sendMessage` 冷恢复两次均有回复 |
| A-3 子代理 usage 归集 | ✅ Host `session/event` 按 childId 汇总 |
| A-4 Host 读 swarm | ✅ 等 Host 服务就绪后 `GET /swarm/api/health` 200 |
| A-5 Host 读 fishkeeper | ❌ 401：`connection.fetch` 路由是浏览器面，写接口需要浏览器凭据 → 自动检查点放 P1 |
| A-7 `agentPreset` | ✅ 显式 preset 子代理创建成功（headless 需自行声明 preset） |
| A-8 写路由保护 | ⚠️ Host 不提供 origin/token 策略，必须 route owner 自己做（本插件已做） |
| A-9 槽位 | ✅ 根/蜂后不占槽；容量 3 时 1 个常驻子代理 + 2 个工蜂刚好，第 3 个 `ACTIVATION_LIMIT_REACHED` |
| 锁 / 哈希链 | ✅ 6 进程竞争仅 1 个写者；死锁接管；截断修复；篡改检测 |
| 假 provider 闭环 | ✅ 信号→开单→唤醒→`watch_decide`→执行→验证→哈希链记账全通 |

完整证据、偏差与 go/no-go 见 **[docs/spike-m0.md](./docs/spike-m0.md)**。

---

## 4. 设计边界（不要过度承诺）

- **v1 的教练不保证送达**：dsh-swarm 0.1.1 的 `steer` 只写 `swarm/intervened` 事件，不投递成员 inbox；本层 coach/throttle 只能留痕。
- **v1 的自动检查点只到运行快照**：鱼数据检查点需要浏览器凭据，宿主侧自动创建是 P1。
- **"0 超支"以监管层存活为前提**：监管层崩溃时仍有 swarm 自身预算兜底，但总支出上限是 `B + S`（`S ≤ 5% × B`）。
- **蜂后不占子代理槽**：M0 已实测根不占槽；8 成员 = 蜂后 + 7 工蜂，7 + 值班员 = 8，刚好。
- **值班员不是万能的**：只做判断，不写代码、不合并、不修 bug。

---

## 5. 目录

```text
overwatch/
├── src/                 # Host 半（M0 地基）
├── e2e/m0/              # M0 探针、脚本化 provider、临时 profile 运行器、证据
├── test/                # 单元测试与双进程锁竞争 helper
├── docs/spike-m0.md     # M0 结论与证据
├── cordis.patch.yml     # 组合包 patch 层
├── package.json
└── scripts/             # 语法检查入口
```

上游项目：

- `github.com/AiLunSin/dsh-pressure`（压力表）
- `github.com/AiLunSin/dsh-swarm`（蜂群）
- `github.com/AiLunSin/fish-keeper-console`（养鱼人控制台）

设计文档（需求单、技术方案、架构图）在项目工作区的 `lianhe/` 目录，未随本仓库发布。

---

## 6. License

MIT
