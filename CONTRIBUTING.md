# 参与贡献

感谢关注 dsh-overwatch。这个项目的核心约束是：**模型可以判，不能动手；硬闸门不靠模型；没有证据不动作。**
提交改动前请确认没有破坏这三条。

## 环境

- Node.js >= 22（CI 覆盖 22 / 24）
- DeepSeek Harness `0.2.2-rc.3`（只有跑真实宿主探针和端到端才需要）
- 可选上游：`dsh-swarm`、`dsh-pressure`、`fishkeeper`（端到端会用到）

```powershell
npm install
npm run check   # lint + test
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run lint` | `node --check` 检查全部源文件 |
| `npm test` | 单元 / 场景 / 路由 / 服务 / 面板测试 |
| `npm run m0` | 真实 DSH 能力探针（脚本化 provider） |
| `npm run m1` | M1/M3 Web 端到端 |
| `npm run m2` | M2 值班员 headless 端到端 |
| `npm run m4:real` | 一次真实模型唤醒（需账号凭据） |
| `npm run m4:abc` | A/B/C 对比（默认 ¥10 上限） |
| `npm run m4:swarm` | 真实 dsh-swarm 信号（无模型费用） |

CI 只跑离线的 lint、测试和打包检查；真实模型与真实宿主探针由维护者在本地执行，结果提交到
`e2e/*/results/`。

## 改代码时

- 硬闸门逻辑必须保持确定性和 fail-closed；任何"拿不到状态就继续"的写法都不接受。
- 值班员的工具表只有 `watch_case`、`watch_evidence`、`watch_decide`；不要给它文件、shell、合并或子代理能力。
- 执行路径统一走 `src/executor.js`：校验 → 授权 → 执行 → 验证 → 记账，保持幂等与串行。
- 新增配置项要同时更新 `src/config.js` 默认值与校验、`examples/profile-patch.yml` 和 `docs/config.md`。
- 面向用户的变更写入 `CHANGELOG.md`。

## 提交与 PR

- 提交信息用 Conventional Commits 风格：`feat(scope): ...`、`fix(scope): ...`、`docs: ...`。
- PR 请说明问题、方案、影响范围和验证方式；模板见 `.github/pull_request_template.md`。
- 提交前确认没有 token、密钥、账号或私密路径进入仓库或测试证据。
- 涉及行为变化时补测试；涉及端到端时附上结果目录。

## 安全

不要为安全问题开公开 issue。请按 [SECURITY.md](./SECURITY.md) 通过私密安全公告报告，
并附 DSH 版本、插件版本、最小复现和影响。不需要提供任何密钥或会话内容。

## 许可

提交贡献即表示同意以 [MIT](./LICENSE) 许可发布。
