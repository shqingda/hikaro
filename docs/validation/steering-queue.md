# Steering 队列管理验收 · 2026-10-20

本节是首次交付的历史记录。2026-10-21 的跨 host 持久恢复结果见文末。

`/tasks` 新增 Steering messages，普通和附着 TUI 共用全文详情、编辑、提前及确认删除。指令有稳定 ID，已消费条目不能修改。管理器持有期间不向下一模型轮注入 steering；当前模型请求及当前工具继续，必要时在下一轮前等待。关闭后消费最新内容，取消可中断等待；身份撤销清除对应条目。界面明确标记 memory only，跨 host 重启持久化未实现。

验证命令及结果：

- `pnpm test tests/steering-queue.test.ts tests/execution-panel.test.ts tests/attached-workflows.test.ts`：6 项通过。
- 添加取消用例及唯一 PTY 后，`pnpm test tests/steering-queue.test.ts tests/steering-queue-pty.test.ts`：3 项通过。合计 8 项不同用例。
- 最终核对补上 release 后立即重新 hold 的等待循环，再执行 `pnpm test tests/steering-queue.test.ts`：2 项通过。
- 类型检查与构建通过；未运行全量测试、其他 E2E 或性能基准。

真实 PTY 启动独立本地 SSE host，先提交运行和三条 steering，再以同身份附着 TUI。通过实际 `/tasks` 编辑第一条、提前第二条、确认删除第三条；释放原模型响应时管理器仍打开，核对没有第二次请求；关闭管理器后核对新请求中的用户内容严格为 start、priority steering、edited steering。

核心测试另外覆盖已消费 ID 拒绝、来源撤销、取消等待不再请求模型，以及释放后立即重新打开管理器时继续暂停。普通 TUI 使用同一适配与面板，但本轮独立真实 PTY 只验证附着入口。本地 fixture 不替代真实模型、物理终端与长期竞争验收。

## 2026-10-21：持久恢复

补充指令的接收、编辑、排序和移除均等待 SQLite 写入后确认。重启后显示待确认，只有原来源身份可以恢复；确认不会启动任务，也不会使其他未确认项生效。消费记录和追加 user message 在同一租约事务内完成，避免删除后、写入历史前崩溃造成丢失。取消/撤销覆盖在途写入；删除失败保留原文和错误，隔离为待确认。正常关闭保留未确认恢复项，删除会话清理记录。

- `pnpm exec vitest run tests/steering-recovery.test.ts tests/steering-queue.test.ts tests/execution-panel.test.ts`：10 项通过。包括恢复身份、顺序、单条确认、不自动启动、事务回滚、过期租约、重复消费、取消/撤销与写入竞争、删除失败隔离、跨连接容量上限及会话清理。
- 唯一 E2E 文件 `tests/steering-queue-pty.test.ts`：原有 SSE 模型队列管理 1 项通过；新增实际构建产物 SIGKILL → host 重启 → 同身份 TUI 确认 → 明确发送新请求 1 项通过。未确认原文仍保留，其他客户端恢复被拒绝。合计 12 个不同定向用例。
- 新 E2E 初次等待了仅运行中显示的状态提示；修正为空闲附着提示后，发现退出面板与输入之间缺少状态同步。补上等待编辑器 footer 恢复后通过，没有增加超时、删除业务断言或改成自动确认。最终定向命令为 `pnpm exec vitest run tests/steering-queue-pty.test.ts -t SIGKILL`。
- `pnpm typecheck`、`pnpm build` 通过。构建复制新增 storage worker 模块，重启 E2E 直接使用 `dist/hikaro.mjs` 验证。未运行全量测试、其他 E2E 或性能基准。

审查覆盖租约与事务、共享队列串行顺序、取消失败状态、恢复身份和分发模块复制；没有新增依赖或降低验收门槛。此处使用本地 SSE/demo provider，不替代真实订阅、物理 IME 或长时稳定性。已有 CI 分发草稿固定在 b08f160；它不包含本轮修改，正式发布前必须重新生成、安装验收当前候选包。
