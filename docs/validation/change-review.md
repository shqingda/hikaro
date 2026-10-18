# TUI 变更审阅与回退验收 · 2026-10-18

实现与验证在独立 worktree、分支 `codex/tui-review-rollback` 完成，未修改移动端工作目录。没有运行全量测试或性能基准。

## 用户入口

在此分支运行 `node dist/hikaro.mjs`。完成一次原生 `write_file` 或 `edit_file` 后，空闲时输入 `/changes`：选修改 → Enter 阅读 → PgUp/PgDn 或 Home/End 翻页 → 选 Roll back this edit → 确认恢复或删除。默认选择保留修改，Esc 返回。重启后记录可继续审阅；旧版本产生的修改没有补录快照。

## 验证结果

| 范围                                                            | 结果                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/change-review.test.ts`                                   | 7 项通过：持久化与重启、恢复内容与权限、新建文件删除、逆序回退、会话隔离、快照失败、未知状态、损坏快照、提交时外部修改、并发回退        |
| `tests/secure-files.test.ts`、`tests/file-coordination.test.ts` | 合计 9 项通过，原文件工具保护未回归                                                                                                     |
| `tests/change-review-panel.test.ts`                             | 3 项通过：完整确认可见才允许执行、文档翻页/返回、空文件与末尾换行差异                                                                   |
| `tests/tui-interactions.test.ts`                                | 16 项通过，已有面板取消、草稿等交互回归                                                                                                 |
| `tests/change-review-pty.test.ts`                               | 1 项通过：真实 CLI/PTY、本地 SSE 模型调用 edit_file，列表 → diff 末页 → 取消 → 再次确认回退 → 文件原内容、SQLite 会话结果消息、正常退出 |
| TypeScript / build / diff whitespace                            | 通过                                                                                                                                    |
| 冲突保护变异检查                                                | 临时颠倒内容比较后，逆序回退测试失败；恢复源码后同一测试通过，变异未保留                                                                |

共 36 项定向测试分别通过，不代表一次全量运行。执行入口为 `node node_modules/vitest/vitest.mjs run <上述文件>`；类型检查为 `node node_modules/typescript/bin/tsc --noEmit`，构建为 `node scripts/build.mjs`。独立 worktree 复用原工作目录依赖，只读使用，不改锁文件。

## 修正记录

先新增文件测试确认缺失实现时失败。实现后文件测试通过；类型检查发现键名大小写与现有组件不同，修正为 pageUp/pageDown。

第一次完整 PTY 未通过：macOS `/var` 别名不符合安全读取要求；规范化 journal home 后再测，回退已成功但列表显示外部路径，导致预期文本未匹配。再规范化 cwd 后 PTY 通过。随后补充末尾换行差异和确认保护，PTY 与既有交互回归再次通过。

新增面板测试直接向面板发送 Esc 导致等待超时；实际 Esc 由外层视图调用 cancelStep，已按该约定修正测试，受影响的一项单独通过。

## 尚未验收或实现

本地模型 fixture 不等于真实账号验收。附着 TUI、整轮/多文件回退、redo、Shell/插件/Pi 修改、子 agent 汇总不在此切片范围。大文件与长期历史性能、自动快照清理仍待补齐。当前改动保留在独立分支，原移动端目录启动的版本不会自动获得新入口。
