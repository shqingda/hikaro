# 嵌套子 agent 树 · 2026-10-24

## 结果

子 agent 可以再委派一层（深度上限不变）。此前根会话的 `/tasks` → Child agents 只列直接子任务，孙任务看不到，也无法从根会话停止。现在 `childTasks(parent)` 按启动顺序深度优先返回全部后代，并附带 `depth` 与 `parentId`；列表用缩进和 `↳` 表示层级，状态显示 `level N`，详情注明由哪个子 agent 委派。

`stopChild` 允许根会话停止自己子树中的任意后代；不属于该子树的任务仍按“not found”拒绝。Plan 模式切换前的“仍有运行中的子任务”检查也随之覆盖孙任务。普通与附着 TUI、移动端共用 `executionItems`，新增字段可选，旧客户端照常显示扁平标题。

## 验证证据

- `tests/execution-children.test.ts` 新增 1 项（先确认缺少实现时失败，只返回 2 条）：真实 runtime 与 demo provider 依次产生子任务、由子任务委派的孙任务、第二个子任务；根会话按 `First child`、`↳ Grandchild`、`Second child` 的树序列出，层级与父 ID 正确；子任务只看到自己的子树；跨子树或跨会话停止被拒绝。
- 2026-10-24 `pnpm check` 退出码 0：116 个应用测试文件、615 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-child-tree.log`。

## 补充：子任务持久索引（同日）

新增 `child_tasks` 表与 `child-tasks.mjs` 存储模块（已加入构建复制清单）。runtime 在子任务开始和结束（成功或失败）时写入任务、状态与最后 64,000 字符输出；写入失败不影响委派本身。打开 `/tasks` 的 Child agents 时先按会话加载整棵已保存子树，与内存中的实时记录合并，实时记录优先。重启后仍为 starting/running/stopping 的记录显示为 `interrupted`，不提供停止操作，也不续跑。删除会话时清理以它为 ID 或父 ID 的记录。

- `tests/execution-children.test.ts` 新增 1 项（先确认缺少实现时失败）：真实 runtime 完成子任务后关闭，再加一条运行中的孙任务记录；重新打开后列表恢复为 `completed` 子任务和 `interrupted` 孙任务，二者都没有操作，停止被拒；删除子会话后记录清除。
- `tests/execution-control-pty.test.ts`：列表多了一次存储读取，原用例在菜单项已有“Child agents”字样时就按 Enter，按键落在“Loading child agents…”上。改为等待列表标题 `Child agents · page`，产品逻辑未改。
- `pnpm check` 退出码 0：116 个应用测试文件、616 项测试，15 项脚本检查（含复制后的存储 worker 启动检查），类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-child-index.log`。

## 未覆盖

真实 PTY 中查看和停止正在运行的孙任务、真实模型的嵌套委派、移动端界面显示。后台终端的持久索引仍待办；子任务只保存状态与输出尾部，不保存完整过程。
