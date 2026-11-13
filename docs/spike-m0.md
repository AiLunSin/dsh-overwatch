# dsh-overwatch · M0 技术验证报告

> 日期：2026-11-14 ｜ 结论：**GO（先 guard-only，值班员标 experimental）**
> 验证基线：DeepSeek Harness `0.2.2-rc.3`（Electron Node `v24.21.0`，Windows 11 26300，x64）
> 代码：本仓库 `src/`、`e2e/m0/` ｜ 证据：`e2e/m0/results/`
> 设计文档：`lianhe/dsh-overwatch-技术方案.md` §2.4、附录 F

---

## 0. 一句话结论

M0 的五项 go 条件全部满足：**值班员可受限、可续聊、可归集 usage；Host 能读 swarm；
假 provider 闭环跑通；锁与哈希链通过崩溃/竞争测试。** 唯一未做实时验证的是 A-6（steer
是否送达成员），而上游源码已明确它只落事件、不投递 inbox——这反而坐实了"v1 教练不保证
送达"的边界。鱼缸的 Host 读接口返回 401，自动检查点按计划退到 P1。

---

## 1. 验证方法

- 用 `e2e/m0/run.mjs` 创建**一次性** `DSH_HOME` 和临时 profile，不触碰 `desktop` profile。
- headless 阶段：`dsh-base + dsh-headless + dsh-swarm + dsh-overwatch`，加脚本化
  provider（`e2e/m0/fake-llm`）和探针（`e2e/m0/probe`）；`subagent.maxActiveSubagents=3`，
  另声明一个 `m0-watch` preset。
- web 阶段：同一临时 home，`dsh-web-app` 模板 + swarm/overwatch/fishkeeper，端口 `0`，
  在探针写完报告后立即杀掉；不打开浏览器。
- **零模型调用、零网络、零费用**：脚本化 provider 按 prompt 标记返回 tool-call/文本。
- 每次运行都会把报告、watch 日志、LLM 请求日志写到 `e2e/m0/results/`；运行总耗时
  约 9.7s，其中 headless 检查约 1.8s、web 检查约 2.4s。

关键实现：`e2e/m0/probe/index.js` 在根 agent 的 `agent/created` 里启动子代理，在子代理的
串行 `agent/created` 监听里先 `restrict` 全部全局工具、再注册 `watch_decide` scoped 工具；
用一个 `m0_hold` 常驻子代理把 headless Host 的"等待子代理工作"延长到探针结束，避免
Host 在异步检查中途退出。

---

## 2. 结果总表

| 编号 | 检查 | 结果 | 证据 |
| --- | --- | --- | --- |
| A-1 | 子代理创建后 `ctx.tools.restrict` 立即生效 | ✅ | 全局工具 41 → 0；子代理可见 `watch_decide`/`m0_hold`；首个模型请求工具表与之一致 |
| A-2 | `delivery:'caller'` 子代理可 `sendMessage` 两次 | ✅ | 结果后子代理**不常驻**，两次冷恢复都收到回复（assistant 消息 3、4 条） |
| A-3 | 子代理 `assistant/message.usage` 可在 Host 归集 | ✅ | 按 childId 聚合 4 次 assistant 调用：input 5000 / output 160 |
| A-4 | Host `fetch(/swarm/api/health)` 可达 | ✅ | 200 `{ok:true,runs:0}`（Host 服务就绪后） |
| A-5 | fishkeeper 的 `connection.fetch` 路由宿主可达 | ✅ 结论=不可达 | 无浏览器凭据返回 **401** `unauthorized`；自动检查点放 P1 |
| A-6 | `steer` 是否进入蜂后/成员上下文 | ⚠️ 未实时跑 | 上游源码：`service.js:671-677` 只 append `swarm/intervened`；`project.js:457-460` 只存入 `state.interventions`，无投递路径 |
| A-7 | `agentPreset` 可指定已安装 preset | ✅ | headless 声明 `m0-watch` 后，子代理创建成功，`stopReason:completed` |
| A-8 | 写 handler 的 origin/token 行为 | ✅ | Host 无策略：跨源 `Origin: https://evil.example` 仍命中 handler（200）；overwatch 自己返回 403 `WRITE_DISABLED` |
| A-9 | 槽位与"蜂后是否占槽" | ✅ | 容量 3、1 个常驻锚点 + 2 个工蜂成功，第 3 个 `ACTIVATION_LIMIT_REACHED`；根不占槽 |
| LOOP | 信号→开单→唤醒→决定→执行→验证 | ✅ | 4 条 watch 事件：case/opened → action/intended → executed → verified；链校验通过 |
| LOCK | 双进程竞争 / 过期接管 | ✅ | 6 个进程同时抢锁，恰好 1 个成功；死 pid 锁可接管 |
| CHAIN | 崩溃/截断 / 篡改 | ✅ | 尾部半行自动截断到最后完整行；中段损坏报错；改字段后 verification 失败 |

`npm test`：**29/29 通过**（store 4、lock 3、policy 6、executor 5、signals 3、http 4、config 4）。

---

## 3. 逐项细节与发现的偏差

### A-1 工具限制

方案原文让用 `ctx.tools.schemas(agent.ctx)` 检查；实际 `schemas()` 的 scope 参数是
**Agent 对象本身**（`dsh-agent-loop/src/agent.ts` 把 `this` 传给 `createScope`）。正确写法：

```js
agent.ctx.tools.restrict({ deny: ctx.tools.schemas().map(s => s.name) })
ctx.tools.schemas(agent)   // 子代理可见工具
```

实测：`before` 41 个全局工具 → `afterRestrict` 0 个；随后在子代理 ctx 注册
`watch_decide` 与测试用 `m0_hold`；子代理首个模型请求只收到这两个工具，`bash/pwsh/
write/subagent/swarm_*` 全部不可见。**限制发生在首个模型请求之前**，满足设计目标。

### A-2 续聊

`delivery:'caller'` 的子代理在结果结算后**不在 registry 里**（`residentBeforeSend:false`），
但 `sendMessage(root, childId, …)` 两次都成功冷恢复并产生新 assistant 消息。也就是说：

- 方案 §2.4 的退路（改 `delivery:'parent'`）**不需要**；
- 值班员常驻不是 A-2 的前提；按"每案唤醒一次 + 需要时续聊"实现即可；
- 冷恢复会重新走 `agent/created`，supervisor 必须在监听里**幂等**地重新施加限制/注册工具。

### A-3 usage

`session/event` 对子代理 session 同样触发；按 `session.id === childId` 归集
`assistant/message.data.usage` 可行。无需 `tokenMeter` 轮询即可做值班员预算的初版账本。

### A-4 / A-5 Host 可达性

- swarm 的 `/swarm/api/health` 在 Host 进程内 `fetch` 返回 200；但**插件行可能早于
  Host 服务就绪**，首次采样必须容忍 404 并重试（本次等 2s 后成功）。
- fishkeeper 的 `/api/fishkeeper/overview` 走 `connection.fetch`，无浏览器凭据返回
  **401**。这不是 bug，是设计：`connection` 是浏览器面。v1 自动检查点必须由面板
  （带浏览器凭据）或人触发，Host 侧自动创建列 P1。

### A-7 preset

headless 模板没有 preset registry。按 `dsh-agent-preset-registry` README 显式插入
registry + `m0-watch` 声明后，`startActivation({agentPreset:'m0-watch'})` 成功。
**web 模板已经自带 registry，不能再插入一份**（本次第一次 web 运行触发
`service "agentPresets" has been registered`，已通过只在 headless 声明修正）。

### A-8 写接口保护

Host 的 web server **没有** server-wide auth/origin 策略：探针注册的
`POST /m0/probe-write` 在 `Origin: https://evil.example` 下依然执行（200）。因此：

- overwatch 必须自己校验 loopback / 同源 / `http.token`（已实现并单测）；
- 任何"只靠 Host 就安全"的假设不成立。

### A-9 槽位

容量公式实测成立：**根/蜂后不占槽**。容量 3 时，1 个常驻锚点 + 2 个工蜂成功，第 3 个
`ACTIVATION_LIMIT_REACHED`。默认 8 槽下，8 成员（蜂后 + 7 工蜂）+ 值班员 = 8，刚好；
再加成员或 reviewer 必须拒绝 arm 或调大 `maxActiveSubagents`。

### 锁与哈希链

- `FileLock` 用 `mkdir` 原子抢锁 + owner.json + 死 pid/超龄接管；6 进程竞争仅 1 个写者；
- `WatchStore` 每条事件带 `prev`/`hash`，重开时校验全链；
- 尾部半行（崩溃窗口）自动截断到最后完整行；中段损坏 `EWATCHCORRUPT`，不静默丢；
- 改字段的篡改被 `EHASH` 捕获；超过 `maxBytesPerRun` 拒绝追加。

### 闭环

信号（budget 96%，真实 `budgetSignal` 计算）→ 开 case → 启动 watch 子代理 →
子代理调用 `watch_decide`（真实 tool 管线）→ policy 校验+授权 → executor 调假 Port →
Port verify → watch.jsonl 写 intended/executed/verified → 链校验通过。
`decisionCalls=1`、`applies=1`、`verified=true`。

---

## 4. 设计偏差与需要回写方案的点

| 编号 | 方案原文 | 实测 | 处理 |
| --- | --- | --- | --- |
| D-M0-1 | `ctx.tools.schemas(agent.ctx)` | scope 参数是 Agent 对象 | 改为 `schemas(agent)`；回写附录 F |
| D-M0-2 | 值班员 `maxDepth:0` | 子代理深度=父+1，`maxDepth:0` 会拒绝创建 | 改 `maxDepth:1`，靠 restrict 禁用 `subagent`+深度 1 双重阻止孙代理 |
| D-M0-3 | caller 子代理常驻续聊 | 结果后不常驻；冷恢复可用 | supervisor 按"冷恢复"设计，不依赖常驻；每次 `agent/created` 幂等重施限制 |
| D-M0-4 | 插件启动即可注册 HTTP 路由 | `webServer` 可能尚未挂载，静默 404 | 用 `ctx.inject(['webServer'], …)`；上游路由首次采样允许 404 重试 |
| D-M0-5 | preset 可随手加 | web 模板已有 registry，重复注册会失败 | 只在需要的 profile 声明；不要覆盖已装 registry |
| D-M0-6 | Host web server 有认证/同源 | 没有，跨源写直达 handler | route owner 必须自校验（本插件已做） |
| D-M0-7 | fishkeeper 宿主可写 | 401；路由属浏览器面 | v1 自动检查点列 P1，面板/人工触发 |

---

## 5. 未验证与风险

- **没有真实模型回合**：脚本化 provider 证明管线与限制，不证明值班员的判断质量、成本
  和 5% 预算是否够。M2 必须用真实模型跑 3 个场景的 A/B（guard-only vs supervised）。
- **A-6 没有实时跑**：源码证据表明 `steer` 只落事件；若要"教练送达"，需要上游加
  message 路由或我们改走 `send_message`（P1）。在 v1 文案里必须写"教练可能不送达"。
- **8 成员 swarm 的 arm 未端到端跑**：槽位公式已实测，但 `swarm_start+arm` 的集成
  属于 M1；本次没有启动真实 swarm run（会创建 worktree、派工蜂、消耗时间）。
- **Windows 文件权限**：只做 best-effort，不宣称 0700/0600。
- **面板/浏览器**：M0 没有 client，未验收 UI。
- **Web 阶段的 401 是预期结论**，不是"fishkeeper 坏了"；鱼缸只读索引在浏览器面仍可用。

---

## 6. go / no-go

技术方案 §16.3 的四条 go 条件：

- A-1/A-2 至少一条可行 → **两条都可行**；
- A-4 可行 → **可行**；
- 假 provider 闭环 → **通过**；
- 锁/哈希链原型 → **通过**。

**结论：GO。** 建议的执行顺序：

1. **M1 先做 guard-only**：arm、采样、信号、开单、pause/abort 的确定性路径、只读 API、
   值班室/事件单面板。验收 I-1/I-3/I-8；先证明硬闸门有用。
2. **M2 值班员标 experimental**：cold-resume 形态、每案一次唤醒、`watch_decide` 三工具、
   decision schema、预算/超时、交接班；用 3 个真实场景对比 guard-only，成本超 5% 就缩唤醒范围。
3. **M3 鱼缸与回放**：自动检查点仍列为 P1；v1 只做只读索引 + 人工恢复 + 风险提示。
4. **A-6 在上游加 message 路由前不作为 v1 卖点**；README/面板文案明确"教练可能不送达"。

---

## 7. 复现

```powershell
cd C:\Users\11403\Desktop\overwatch
npm test
npm run lint
npm run m0          # 需要本机 Desktop 安装；会创建并删除临时 DSH_HOME
```

证据：

- `e2e/m0/results/headless.json`：A-1/A-2/A-3/A-7/A-9/LOOP
- `e2e/m0/results/web.json`：A-4/A-5/A-8
- `e2e/m0/results/headless-watch.jsonl` / `web-watch.jsonl`：哈希链原文
- `e2e/m0/results/summary.json`：环境、耗时、错误
- `e2e/m0/results/headless-llm.jsonl`：脚本化 provider 收到的工具表与 prompt 标记（测试用，不含真实模型内容）
