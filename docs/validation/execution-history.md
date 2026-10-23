# 最近执行历史验收 · 2026-10-20

2026-10-23 后续已增加全部已保留运行的分页与精确 ID 查询，见 [分页验收](execution-history-pagination.md)。下文保留旧接口与首切片的历史证据；新版仍兼容该最近窗口。

普通和附着 `/tasks` 增加只读 Execution history，读取本会话最近 200 条 run 事件，聚合最多 100 次运行。显示 ID、已记录终态、时间、provider/model 或操作类型、错误和用量。缺失结束事件明确显示 unknown，不推断仍在运行或已退出。详情手动刷新，不每 500ms 重读持久历史。

验证：

- `pnpm test tests/execution-history.test.ts tests/execution-panel.test.ts tests/attached-workflows.test.ts`：6 项通过。
- 补齐数量上限和唯一真实 PTY 后，`pnpm test tests/execution-history.test.ts tests/execution-history-pty.test.ts`：3 项通过。合计 8 项不同用例。
- 历史详情改为手动刷新后重新执行受影响面板测试；类型检查与构建通过。

存储测试实际关闭并重新打开 SQLite，覆盖失败及错误内容、缺少终态、会话隔离、已取消终态、最近 200 事件/最多 100 运行边界与排序。真实 PTY 先通过独立 demo host 完成一次任务，拒绝对历史条目的 stop 操作；正常关闭并重启 host 后，附着 `/tasks` 打开历史详情，核对相同 run ID 和 completed 状态，再逐级返回主输入栏，核对只有一次 run.start。

这不是全量历史搜索，也不是后台终端及子任务的独立持久索引。实际输出全文仍在会话记录中。缺少结束记录的状态用存储 fixture 覆盖；真实 PTY 此轮覆盖的是已完成运行的重启阅读。本地 demo 不代表真实账号、长期大历史性能或物理终端验收；未运行全量测试、其他 E2E 或性能基准。
