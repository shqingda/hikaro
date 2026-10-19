# 自动上下文压缩

## 目标与边界

在完整模型请求预算接近上限时，自动把已完成的旧用户轮折叠为同会话 checkpoint。继续使用当前 session ID，CLI、TUI、RPC 不需要换绑。完整原始消息和文件来源保持可查询，不删除、不改写、不重放。

本次沿用已标明方法的 token 估算与图片预留，不宣称精确 tokenizer 或真实摘要质量已经验收。单个当前用户轮超限时明确失败，不截断工具配对或当前约束。手动 `/compact` 的续接会话接口保持兼容。

## 验收条件

1. system、当前工具 schema、消息、图片、输出预留和安全余量都计入请求；达到可用输入预算的 85%，或需要裁剪旧消息时，且存在可压缩旧轮，先摘要再请求正常回答。
2. 压缩边界固定为本轮最初用户消息之前。该用户消息、后续 steering、assistant tool call 与 tool result 保持原样；绝不把缺失结果的操作当作完成。
3. 摘要分页读取旧消息并包含 seq、工具参数、路径、结果和错误标记；增量压缩合并上次摘要与新增旧轮，原历史仍能分页读取。
4. 只有非空、受预算约束、能减少请求尺寸且使完整请求装得下的摘要才能生效。SQLite 在同一事务中验证租约、旧 checkpoint 版本、源边界和消息版本，并写入 checkpoint 与审计事件。
5. 摘要调用遵守同一取消信号、租约 fencing、共享 modelCalls 和 cost 限额。失败、取消、失去租约、源版本变化不提交候选摘要，也不进入正常模型/工具执行。
6. 重启后读取已提交 checkpoint；未提交的摘要不会恢复或隐式重试。再次请求只恢复正常任务，不重放任何工具副作用。
7. 同一轮没有新增可压缩旧消息时不循环摘要。摘要后仍超限时给出明确错误，保留之前 checkpoint 和全部源消息。

## 实现顺序与文件

- `packages/storage`：checkpoint schema、带版本校验的事务提交、原始来源分页、恢复视图。
- `packages/core`：预算触发、旧轮边界、共享预算摘要调用、候选验证、提交和重新读取。
- `packages/runtime/src/index.ts`：仅按需要补齐手动续接事务，不改变客户端返回契约。
- `tests/auto-compaction.test.ts`：真实 SQLite + 可控 provider，覆盖正常路径与失败边界。

沿用 TypeScript strict、显式类型、无新增依赖。状态变更先验证再提交，例如 `await checkExecution(signal); await store.commitContextCheckpoint(...)`；事务内再次检查租约和源版本，禁止只在事务外检查。

## 验证命令

```sh
pnpm test tests/auto-compaction.test.ts tests/context-budget.test.ts tests/core.test.ts tests/lease-fencing.test.ts
pnpm typecheck
git diff --check
```

先记录 RED，再做最小 GREEN；只跑定向单元/存储集成测试，不跑全量、PTY/E2E 或性能基准。不得降低 harness 门槛、删测、跳过失败测试。运行中的模型请求仍采用协作取消；存储 worker 在事务内用共享原子状态决定取消或提交，因此排队等待写锁时仍可取消。提交决策胜出后，已验证的摘要可持久化；原始历史始终不变。

## 当前证据与限制

- 新增 checkpoint 与自动压缩测试先 RED、后 GREEN；自动压缩、预算、core、租约、模型设置、会话设置和 runtime 生命周期共 7 个定向文件、105 项测试通过，TypeScript strict 检查通过。
- 恢复当前未配对工具操作仍使用既有 8 MiB 历史窗口。如果最后一个旧用户轮单独超过该上限，恢复阶段会明确拒绝，尚不能自动摘要救援；多轮累计超过上限不受此限制。保留原容量断言，不提高存储上限。
- 旧图片的原始数据仍在消息存储中；摘要输入只含图片类型和来源序号，不重新发送全部历史图片。当前用户轮的图片保持原样。图片内容的语义完整性与生成摘要的质量仍需真实模型评估。
- 摘要调用与回答共用现有 Agent 生命周期内的调用数和费用预算；未引入跨进程账本或精确 tokenizer。
