# 普通 TUI 未答问题恢复验收

日期：2026-10-23。对应 [规格](../specs/local-question-recovery.md)。

普通 TUI 与 host 使用同一 `QuestionService` 和 SQLite 问题事务；普通身份固定为 `standalone:tui`，不会读取 host 默认身份、附着客户端或设备的问题。保存真实执行会话及审批归属会话，正常问答保存审计后返回原工具；恢复答案只写原会话上下文。

启动和切换会话提示 `/questions`。绑定新会话前同步使旧问题读取、面板和提交失效。退出先关闭问题服务，再同步取消当前运行、销毁界面并关闭 runtime；SQLite 关闭前等待问题和普通输入草稿写入。正常退出不会把未答问题标为取消。

恢复面板明确不自动续跑。旧执行租约仍有效时拒绝答案及取消的提交；保留当前答案，用户手动重试。正常问答保存失败也保留答案；退出失败重试面板只离开界面，不取消问题。其他面板占用导致初次展示失败时，问题仍可在同进程通过 `/questions` 回答。

## 验证证据

- 先运行普通 TUI PTY 得到 RED：真实问答已经显示，但 `pendingQuestions(session, "standalone:tui")` 返回空数组。证明原入口未持久化问题。
- 独立审查后补两项 RED：正常问答保存失败不显示重试面板；另一面板占用后同实例问题没有可用入口。修复后均通过。
- 新增延迟问题读取回归，绑定新会话开始时即使旧读取尚未返回，也不能再弹出旧问题。
- `pnpm exec vitest run tests/local-question-recovery.test.ts tests/question-recovery.test.ts tests/attached-workflows.test.ts tests/planning-panel.test.ts tests/planning.test.ts`：5 文件、17 项通过。覆盖保存、退出保留、显式取消、重复处理、身份隔离、切换与关闭竞态、租约保护、失败后手动重试和原 host 行为。
- `pnpm typecheck` 通过；改动文件格式检查通过。
- `pnpm exec vitest run tests/local-question-recovery-pty.test.ts tests/question-recovery-pty.test.ts tests/planning-pty.test.ts`：3 文件、3 项通过。加上上述定向检查，共 8 文件、20 项不同测试通过。

真实普通 TUI PTY 使用本地 SSE fixture 触发 `ask_user`，先确认问题已保存，再 SIGKILL 进程。重启出现 `/questions` 提示；立即回答被真实旧租约拒绝，等待租约自然到期后手动重试成功。没有改写租约或伪造到期。恢复完成后模型请求数仍为 1；用户另发消息后请求数才变为 2，并包含原问题的答案。Plan 保持只读。再次触发问答并 SIGTERM，进程正常退出，问题仍 pending，请求数保持 3。

原 host 强杀恢复 PTY 和 Plan 问答／执行 PTY 同步回归。主任务随后统一完成 `pnpm check`：102 个应用测试文件、514 项应用测试及 14 项脚本检查通过，根类型检查与 CLI 构建通过。日志：`/tmp/hikaro-check-20261023-local-questions.log`。此结果由主任务运行并回报，与上述定向验证分开记录。

本片原先保留的“取消记录写入失败后需重启”边界，后续已由 [同进程取消恢复](question-cancellation-recovery.md)补齐；上面的初始验证数量保持不变。

## 仍未覆盖或未实现

- 未提交的答案输入草稿不跨进程保存；退出失败重试面板后，再开问题需重新作答。
- 历史版本普通 TUI 从未保存的问题无法补恢复；不跨身份接管，不自动恢复运行或待发消息。
- 子代理问题沿用真实执行会话与 `approvalAuthority` 归属设计；本次普通 PTY 使用主代理，未另做普通子代理崩溃 PTY。
