# 嵌套子 agent 树 · 2026-10-24

## 结果

子 agent 可以再委派一层（深度上限不变）。此前根会话的 `/tasks` → Child agents 只列直接子任务，孙任务看不到，也无法从根会话停止。现在 `childTasks(parent)` 按启动顺序深度优先返回全部后代，并附带 `depth` 与 `parentId`；列表用缩进和 `↳` 表示层级，状态显示 `level N`，详情注明由哪个子 agent 委派。

`stopChild` 允许根会话停止自己子树中的任意后代；不属于该子树的任务仍按“not found”拒绝。Plan 模式切换前的“仍有运行中的子任务”检查也随之覆盖孙任务。普通与附着 TUI、移动端共用 `executionItems`，新增字段可选，旧客户端照常显示扁平标题。

## 验证证据

- `tests/execution-children.test.ts` 新增 1 项（先确认缺少实现时失败，只返回 2 条）：真实 runtime 与 demo provider 依次产生子任务、由子任务委派的孙任务、第二个子任务；根会话按 `First child`、`↳ Grandchild`、`Second child` 的树序列出，层级与父 ID 正确；子任务只看到自己的子树；跨子树或跨会话停止被拒绝。
- 2026-10-24 `pnpm check` 退出码 0：116 个应用测试文件、615 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-child-tree.log`。

## 未覆盖

真实 PTY 中查看和停止正在运行的孙任务、真实模型的嵌套委派、移动端界面显示。子任务记录仍只保存在内存中，host 重启后不保留（独立持久索引仍待办）。
