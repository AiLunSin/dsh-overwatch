## 变更摘要

<!-- 这个 PR 解决什么问题？为什么这样改？ -->

## 影响范围

- [ ] Guard（确定性硬闸门）
- [ ] Watch（值班员）
- [ ] Evidence（证据账 / 哈希链 / 批准队列）
- [ ] 面板 / HTTP API
- [ ] 发布 / CI
- [ ] 文档

## 验证

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] 涉及行为变化时补充了测试，或说明为何不需要
- [ ] 涉及 e2e 时注明结果目录（如 `e2e/m4/abc/results/`）

## 检查清单

- [ ] 没有提交 token、密钥、账号或私密路径
- [ ] 硬闸门相关改动不依赖模型，且失败时 fail-closed
- [ ] `observe` 仍然只记录不执行；人工批准不能越过 `observe`
- [ ] 新增配置项已写入 `src/config.js`、示例与 `docs/config.md`
- [ ] 面向用户的变更已更新 `CHANGELOG.md`
