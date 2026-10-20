# Steering 队列管理验收 · 2026-10-20

`/tasks` 新增 Steering messages，普通和附着 TUI 共用全文详情、编辑、提前及确认删除。指令有稳定 ID，已消费条目不能修改。管理器持有期间不向下一模型轮注入 steering；当前模型请求及当前工具继续，必要时在下一轮前等待。关闭后消费最新内容，取消可中断等待；身份撤销清除对应条目。界面明确标记 memory only，跨 host 重启持久化未实现。

验证命令及结果：

- `pnpm test tests/steering-queue.test.ts tests/execution-panel.test.ts tests/attached-workflows.test.ts`：6 项通过。
- 添加取消用例及唯一 PTY 后，`pnpm test tests/steering-queue.test.ts tests/steering-queue-pty.test.ts`：3 项通过。合计 8 项不同用例。
- 最终核对补上 release 后立即重新 hold 的等待循环，再执行 `pnpm test tests/steering-queue.test.ts`：2 项通过。
- 类型检查与构建通过；未运行全量测试、其他 E2E 或性能基准。

真实 PTY 启动独立本地 SSE host，先提交运行和三条 steering，再以同身份附着 TUI。通过实际 `/tasks` 编辑第一条、提前第二条、确认删除第三条；释放原模型响应时管理器仍打开，核对没有第二次请求；关闭管理器后核对新请求中的用户内容严格为 start、priority steering、edited steering。

核心测试另外覆盖已消费 ID 拒绝、来源撤销、取消等待不再请求模型，以及释放后立即重新打开管理器时继续暂停。普通 TUI 使用同一适配与面板，但本轮独立真实 PTY 只验证附着入口。本地 fixture 不替代真实模型、物理终端与长期竞争验收。
