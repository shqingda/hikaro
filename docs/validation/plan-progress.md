# 计划逐步骤进度验收 · 2026-10-24

## 结果

普通与附着 TUI 新增 `/plan progress`，只读显示已批准计划每一步的状态与备注。状态由模型在执行中通过 `update_plan_step` 报告，界面标题和正文都标明“reported by the model”，并提示以 `/changes` 和测试核对实际结果。读取与刷新不会进入 Plan 模式、发送消息或续跑执行。契约见 [规格](../specs/plan-progress.md)。

批准时为该计划初始化全部 `pending` 进度，与计划状态同文件原子写入；重新进入 Plan 模式或提交新计划时清除。工具校验计划 ID、步骤范围、状态枚举及是否处于执行阶段，任何不符都返回错误且不改状态。Plan 只读模式下该工具不在允许集合内。两端执行提示统一为 `planExecutionPrompt`，要求模型在每步开始与结束时报告。

`planning.get()` 形状保持不变；新 host 的 `plan.read` 额外返回 `progress`（无进度时为 `null`）。附着 TUI 遇到不含该字段的旧 host 时提示升级，不猜测状态。

## 验证证据

- `tests/plan-progress.test.ts` 2 项：初始化、更新、错误 ID/越界/非法状态/未批准拒绝、重启重读、重新进入 Plan 时清除，以及执行提示内容。先确认缺少实现时失败，再实现通过。
- `tests/planning-pty.test.ts` 普通 TUI 真实 PTY（本地模型 fixture）：只读阶段的工具列表不含 `update_plan_step`；批准后模型写文件并报告第 1 步完成，`/plan progress` 显示 `1/1 steps reported completed`、`✓ Completed` 与备注，Esc 返回编辑器。
- `tests/attached-workflows.test.ts` 新增 3 项：附着面板显示新 host 的进度，旧 host 提示升级，两者都不调用 `plan.set` 或 `prompt`；真实 `RpcWorkflows` 的 `plan.read` 在批准前返回 `null`，报告后返回对应状态。
- 2026-10-24 `pnpm check` 退出码 0：114 个应用测试文件、609 项测试，15 项脚本检查，类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-plan-progress.log`。

## 补充：与实际修改对照（同日）

批准时记录 `approvedAt`。`/plan progress` 和 host 的 `plan.read` 额外给出 `recordedEdits`，即批准后修改日志记录到的文件工具修改条数。这只是条数对照，不能证明每一步的内容正确，也不包含 Shell 或插件修改。旧版本保存的进度没有批准时间，此时不显示条数。

- `tests/plan-progress.test.ts`：批准写入 `approvedAt`。`tests/attached-workflows.test.ts`：真实 `RpcWorkflows` 在批准后的 0 次与 1 次修改时返回对应条数，附着面板显示条数。`tests/planning-pty.test.ts` 真实 PTY：执行阶段写 1 个文件后显示 `1 file edits recorded since approval`。

`update_plan_step` 只在会话有已批准、正在执行的计划时才发给模型，Plan 只读阶段和普通会话都不提供，避免无关请求多占 token 或误导模型。`tests/plan-progress.test.ts` 用真实 runtime 的工具策略验证：普通会话、只读计划阶段为否，批准后为是，其他工具不受影响。`pnpm check`：117 个文件、620 项测试通过，日志 `/tmp/hikaro-check-20261024-plan-tool.log`。

附着 TUI 真实 PTY（`tests/attached-workflows-pty.test.ts`）：在共享 host 上批准并执行计划后输入 `/plan progress`，看到“Plan progress · reported by the model”、步骤完成数和批准后修改条数，Esc 返回编辑器。连续两次运行通过。

## 未覆盖

本轮未调整发布百分比。
