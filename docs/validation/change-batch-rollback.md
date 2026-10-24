# 回退到此处（多文件批量回退）验收 · 2026-10-24

## 结果

`/changes` 详情页对仍为 `committed` 的修改，在其后还有其他 `committed` 修改时提供“Roll back to here (N changes)…”。确认页列出条数、涉及文件与将被删除的新建文件数，默认焦点为取消，须完整显示说明后才能确认。执行从最新到选中条逐条调用既有单条回退，遇到第一个失败即停止，显示“已回退 N/M”、停止处文件与原因，其余修改保持不变。范围内有未完成的写入或回退时不提供批量入口。契约见 [规格](../specs/change-batch-rollback.md)。

实现位于共享的 `openChangeReview`，普通与附着 TUI 共用；附着端通过既有 `changes.list` / `changes.rollback` 完成，协议和日志格式未改。

## 验证证据

- `tests/change-batch-rollback.test.ts` 3 项（先确认缺少实现时失败）：目标选择会跳过已回退项；单条时不提供批量入口；遇到未完成状态时拒绝。基于真实 `ChangeJournal` 和临时文件：两个文件三次修改（含新建）整批恢复；第二轮在中间文件制造用户修改后，只回退了 1/3 就停止，较新内容和其余记录保持不变；取消后不再继续下一条。
- `tests/change-batch-rollback-pty.test.ts` 普通 TUI 真实 PTY（本地模型 fixture）：模型新建 `notes.txt` 并修改 `sample.txt`。从 `/changes` 选较早一条，执行“回退到此处”：确认页显示将删除 1 个新建文件；完成后提示 `Rolled back 2 changes across 2 files`，磁盘上 `sample.txt` 恢复原文，`notes.txt` 已删除。
- 2026-10-24 `pnpm check` 退出码 0：116 个应用测试文件、613 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-batch-rollback.log`。

## 补充：按模型轮次回退（同日）

工具上下文新增可选的 `runId`（当前模型运行）。文件工具写入修改日志时一并记录，旧记录和 redo 产生的记录没有该字段。`/changes` 列表在描述后显示 `run xxxxxxxx`；详情页在同一轮还有其他 `committed` 修改时提供“Roll back this run (N changes)…”，目标为该轮全部已提交修改，从新到旧执行。确认页标明 run 前缀，失败即停的语义与“回退到此处”相同。该轮内有未完成的写入或回退时不提供此入口。

- `tests/change-batch-rollback.test.ts` 新增 1 项（先确认缺少实现时失败）：两轮修改加一条无 run ID 的旧式记录；选第一轮的修改只选中该轮的两条，回退后另一轮与旧记录保持不变；单条的轮次和无 run ID 的记录不提供入口。
- `tests/change-batch-rollback-pty.test.ts` 真实 PTY：同一轮的两次模型修改在列表中显示 run 标记，详情页同时提供两种批量入口，“回退到此处”仍按原结果完成。
- `pnpm check` 退出码 0：117 个应用测试文件、618 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-run-rollback.log`。

## 未覆盖

附着 TUI 的真实 PTY 批量流程（共享代码，但未单独跑）、“回退这一轮”的真实 PTY 点击、Shell/插件/子 agent 修改、跨文件原子性。同一毫秒内的多次修改在日志中的先后顺序沿用既有的时间戳加 ID 排序，本轮未改。
