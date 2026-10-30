# 变更审阅与回退（普通 TUI 首个完整切片）

## 目标和用户流程

在普通 Hikaro TUI 输入 `/changes`，选择当前会话的一次文件修改，分页阅读差异，选择回退并确认，看到成功或冲突原因后返回列表。新建文件回退会删除该文件；已有文件恢复当次修改前内容。同文件多次修改按逆序逐次回退。此版本不宣称整轮原子回滚。

记录覆盖本版本启用后原生 write_file/edit_file 的成功操作。快照在安全文件工具持锁期间、提交前持久保存，提交成功后标记完成。重启仍可审阅。Shell、第三方插件、外部 Pi、其他会话和子 agent 的修改不冒充当前会话可回退记录，界面明确说明覆盖范围。附着版入口属于 tui-parity 后续工作。

## 安全和恢复

回退仅作用于记录的规范路径，复用安全文件 helper、文件锁、内容比较、提交前版本检查和会话执行租约。必须空闲，确认显示路径及创建/修改类型。当前文件内容不等于记录的修改后内容则拒绝，保留外部修改。记录状态不确定时不自动回退。禁止 git reset/checkout/clean；不改 index。用户确认是此次回退的授权，不调用模型批准。成功回退写入会话上下文。中断不重放未知操作。

快照目录位于 Hikaro 数据目录，私有文件权限，文件大小沿用文件工具上限。列表每页 20 条，差异完整读取后分页显示，文本渲染过滤控制字符。取消恢复编辑焦点和原草稿。快照不可读/损坏时错误可见。

## 实现位置和风格

TypeScript/Node，复用现有命名与格式。`packages/tools`：安全更新和快照；`packages/runtime`：会话隔离与回退；`packages/tui`：选择器与差异页；`packages/cli`：命令；`tests`：真实文件和 PTY。采用 `async rollback(...)` 风格，不新增依赖或数据库表。

## 实施顺序与验证

1. 记录与安全恢复：tests/change-review.test.ts，验证编辑、新建、重启、冲突、拒绝未知状态及并发。
2. `/changes` 完整交互：tests/change-review-pty.test.ts，一个本地模型 fixture 驱动真实文件修改、打开 diff、取消和确认回退的 PTY 场景。
3. 受影响 helper 回归：tests/secure-files.test.ts、tests/file-coordination.test.ts；类型检查与构建。

命令：`pnpm exec vitest run tests/change-review.test.ts`；`pnpm exec vitest run tests/change-review-pty.test.ts`；`pnpm exec vitest run tests/secure-files.test.ts tests/file-coordination.test.ts`；`pnpm typecheck`；`pnpm build`。

测试按切片定向执行，不运行全量或性能基准。文档不以接口存在作为交付，记录实际场景和限制。

## 当前限制

快照保存在 `<home>/changes/<session-id 的 SHA-256>/`，目前没有自动保留期限，也不随会话删除清理。列表最多 10,000 条，当前仍逐条读取元数据；大历史加载和 16 MiB 上限附近的差异显示尚未做性能验收。只恢复内容，保留回退时的文件权限；不恢复历史权限、目录或其他文件元数据。

实际验证与修正记录见 [验收记录](../validation/change-review.md)。
