# dsh-overwatch 详情

## 它解决什么

多 agent 并行时，真正难的不是"再派一个 agent 去盯着"，而是三件事：

1. **硬边界必须不依赖模型**：预算到 95% 该暂停、100% 该中止、日志坏了该停、墙钟到点该收工——这些不能等模型判断。
2. **软判断需要上下文**：为什么卡住、该教练还是该暂停、证据够不够——这些值得让一个受限制的 agent 线程来看。
3. **事后要能还原**：判断、动作、验证必须各有一条记录，且能被独立校验。

dsh-overwatch 把这三件事拆成 Guard / Watch / Evidence 三层，叠加在
dsh-swarm（运行事实）、dsh-pressure（token 读数）、fish-keeper-console（审计）
之上，不改写三个上游。

## 当前版本（0.1.0，M0）

已实现 Host 地基：

- 配置校验（技术方案附录 A）
- `watch.jsonl` 单写者 + 哈希链 + 崩溃尾部修复
- 信号纯函数（预算/失败连击/停滞/上下文压力）
- 决定校验与授权矩阵，L2+ 强制证据
- 执行器：校验→授权→执行→验证→记账，幂等、串行
- 三个上游只读 Port；swarm 的 `intervene` 写
- `/overwatch/api/health` 等只读 API

**未实现**：arm、采样循环、开单、值班员、面板、检查点、交接班。
因此当前安装后不会自动干预任何运行。

## 健康检查

```http
GET /overwatch/api/health
```

返回版本、模式、数据目录、watch 链校验（事件数、最后哈希），以及
`swarm/pressure/fish` Port 是否可用。

写接口（M1 起）要求 `http.token`；token 为空时写接口直接 403
`WRITE_DISABLED`。浏览器写请求还会检查 `Origin` 与 Host 同源。

## 数据

`$DSH_HOME/overwatch/watch.jsonl`（或 `storage.dataDir`）：

- 只记录判断、动作、验证与稳定 code
- 不记录 prompt、工具参数正文、上游载荷、凭据
- 首事件 `prev: genesis`；后续每条带 `prev` 与 `hash`
- 行级 JSON，损坏在尾部可自动截断；中段损坏会明确报错而不是静默丢弃

## 验证

`npm run m0` 会用脚本化 provider 在临时 `DSH_HOME`/profile 中跑真实 DSH
回合，验证工具限制、续聊、usage 归集、HTTP 可达性、槽位和闭环。结论见
[spike-m0.md](./spike-m0.md)。

## 限制

- 教练/节流只保证写到 watch 日志与 swarm `steer` 事件；成员 inbox 投递要等
  上游 message 路由（P1）。
- 自动鱼数据检查点需要浏览器凭据，v1 不做（P1）。
- 无面板；所有状态目前通过 HTTP 与 watch 日志查看。
