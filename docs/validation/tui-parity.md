# 附着 TUI 核心工作流验收 · 2026-10-18

分支：`codex/tui-review-rollback`。工作区：`/Users/shqingda/.codex/worktrees/tui-review-rollback/hikaro`。

## 实际交付

普通和附着 TUI 复用审阅、执行管理、Plan 与结构化回答面板。附着版从 `/changes`、`/tasks`、`/plan` 进入，操作由独立 host 执行，界面等待结果并显示状态；不是仅新增 RPC 方法。

执行管理的异步数据加载有明确提示。加载阶段不展示可操作的旧菜单，不把提前按下的 Enter 累积到下一页；详情的迟到刷新不会覆盖后续页面。待发消息编辑使用原始文本字段，不从展示文本反向截取。管理期间暂停派发，关闭释放；断线后 host 的 15 秒租约到期自动恢复。

host 维护文件快照、执行记录、问题归属和计划版本。列表按条数/序列化字节量限制，快照每块 16,000 字符；客户端核对记录一致后组装。控制操作绑定所选会话并检查权限；读取允许 view，修改只允许 control/owner。所有修改沿用持久命令回执；计划批准与启动用一个命令 ID，重复 ID 不产生第二轮。

## 本轮验证

共 37 项不同测试分别通过，未运行全量、其他 PTY 脚本或性能基准。

| 范围                                                                                               | 结果                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attached-workflows-pty.test.ts                                                                     | 1 项：独立 host 进程＋真实附着 PTY；读取、拦截 Plan 写入、选择回答并进入模型请求、审阅/修改计划、取消确认不写入、批准后写入、差异审阅/回退且文件恢复                                      |
| 同一 PTY 后半段                                                                                    | 待发消息删除、编辑、移至队首；终端输入 `hello` 并核对 `RESPONSE:hello`，停止后核对 exited；子任务取消并核对 cancelled；面板关闭前没有派发，关闭后按调整顺序执行，删除与旧文本没有发给模型 |
| attached-workflows.test.ts                                                                         | 3 项：快照分块/列表字节限制/真实回退；问题跨会话拒绝、只能回答一次、取消清理；暂停到期；计划版本与同 ID 回执去重，只有一次 run.start；断线迟到读取丢弃                                    |
| execution-panel.test.ts                                                                            | 2 项：普通面板编辑与释放；延迟 list/detail 时显示加载、移除旧选项、提前 Enter 不执行动作                                                                                                  |
| planning-panel.test.ts、change-review-panel.test.ts、tui-interactions.test.ts、permissions.test.ts | 27 项：共享面板、草稿、审批、结构化问题及权限的定向回归                                                                                                                                   |
| client-connection.test.ts                                                                          | 3 项：连接恢复、不重放、意图先持久保存及连接代次隔离                                                                                                                                      |
| shared-host.test.ts 指定首场景                                                                     | 1 项：本机 IPC＋加密设备 adapter；view 可读新增工作流而不能操作，审批归属/竞争/撤权及原有流程不回归                                                                                       |
| TypeScript、构建、diff 空白检查                                                                    | 通过                                                                                                                                                                                      |

使用已安装依赖直接执行：

```sh
node node_modules/vitest/vitest.mjs run tests/attached-workflows.test.ts tests/execution-panel.test.ts tests/planning-panel.test.ts tests/change-review-panel.test.ts tests/tui-interactions.test.ts tests/permissions.test.ts tests/attached-workflows-pty.test.ts
node node_modules/vitest/vitest.mjs run tests/client-connection.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
```

## 失败与修复记录

上一轮脚本先后卡在启动提示匹配、审阅关闭后的连续按键、待发消息详情；达到仓库重试上限后停止，用户明确要求继续定位。

本轮延迟响应回归先复现了旧菜单残留。根因有两处：测试等待的“Pending messages”同时存在于上一层菜单；界面等待 RPC 时旧选项仍可见但没有待处理输入。修复为显式加载状态，列表标题包含页码，脚本按新输出中的确切列表页推进；保留所有真实操作与终态断言，未增加固定等待或放宽超时。

新增断线回归先复现迟到读取仍继续操作；增加连接代次及会话检查后通过。去重验证最初误用客户端尚未收敛的回执状态，现查询 host 的持久回执确认完成再检查重复命令和执行次数。类型检查发现测试用了项目目标库未声明的 Promise.withResolvers，改用普通 Promise 延迟辅助函数，没有修改编译目标。

授权回归揭示加载权限时把“无保存设置”默认成显式 ask，改变了 host 的工作区信任语义，导致既有审批断言失败。修复为读取明确保存的值；缺省仍交给原有 host 策略，完整审批回归通过，没有改弱审批断言。

## 尚未完成的范围

- 未答问题和执行暂停租约在 host 内存中；host 强退后不能恢复未答问题或待发队列。重连不重放已发送动作。
- 问题/计划每 750 ms 读取一次；状态不变不重复请求界面渲染。长期 CPU/内存、大文件差异和大历史性能未测。
- 仅记录原生文件工具编辑，未覆盖 Shell/插件修改、批量回退、redo、嵌套子任务历史树或忽略信号的进程强杀。
- 附着版完整会话选择器、登录、设置、资源/插件与手动工具入口仍未全部对齐。TODO 保持总项未完成，仅将本次四个核心流程记录为已交付。
