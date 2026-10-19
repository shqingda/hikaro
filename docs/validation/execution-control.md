# 执行管理验收 · 2026-10-18

在独立 worktree `/Users/shqingda/.codex/worktrees/tui-review-rollback/hikaro`、分支 `codex/tui-review-rollback` 完成。未修改、合并或提交移动端工作目录。

## 用户操作

运行此分支的 `node dist/hikaro.mjs`，输入 `/tasks`。选择 Pending messages / Background terminals / Child agents，再选择具体条目，详情下方提供操作。↑↓选择，Enter 确认，PgUp/PgDn 阅读长输出，Esc 返回。管理器打开时待发消息暂停派发，当前任务继续；关闭后恢复。若运行任务请求审批，管理器退出并显示审批。

待发消息支持编辑文本、移到队首、确认移除。图片附件保留，只显示数量，此版本不支持在管理器替换图片。后台终端可查看不消费模型缓冲的输出、发送一行输入、请求停止；详情自动显示真实退出码。子 agent 可查看直接委派任务及输出、请求停止并核对最终状态。

## 验证

| 定向文件或过滤器                                                            | 结果与证据                                                                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution-queue.test.ts                                                     | 1 项通过：派发暂停、编辑/排序/移除、重复释放、拒绝修改已派发消息、实际 provider 收到修改后的正文                                                                                        |
| execution-terminal.test.ts                                                  | 1 项通过：真实 PTY 输出、输入响应、非消费预览、跨会话拒绝、停止请求与真实退出、模型读取后仍可查看终态                                                                                   |
| terminal-cancellation.test.ts                                               | 1 项通过：原加载期间取消保护未回归                                                                                                                                                      |
| execution-children.test.ts                                                  | 1 项通过：真实离线子 agent 完成结果保留、父子隔离、终态不被停止请求篡改                                                                                                                 |
| execution-panel.test.ts                                                     | 1 项通过：真实面板键盘编辑待发消息、关闭释放派发暂停                                                                                                                                    |
| tui-interactions.test.ts                                                    | 17 项通过：包含新增管理器让出审批、审批未自动拒绝、保留草稿；既有交互回归                                                                                                               |
| change-review-panel.test.ts                                                 | 3 项通过：共享阅读器变化未破坏差异分页与确认保护                                                                                                                                        |
| core.test.ts 过滤 normalizes provider cancellation / resumes prompts queued | 2 项通过，27 项未选取：原取消及手动工具后的排队恢复                                                                                                                                     |
| execution-control-pty.test.ts                                               | 1 项通过：真实 CLI + 本地 SSE 模型，移除消息、编辑待发正文、进程输入与响应、停止并观察退出码、停止子 agent 并看到 cancelled、关闭管理器后才执行修改后的消息；移除的消息没有进入模型请求 |
| TypeScript、build、git diff --check                                         | 通过                                                                                                                                                                                    |

共 28 项分别通过，不是一次全量运行。使用 `node node_modules/vitest/vitest.mjs run <定向文件>`，核心回归指定 `-t`；类型检查为 `node node_modules/typescript/bin/tsc --noEmit`；构建为 `node scripts/build.mjs`。未运行全量、其他 E2E 或性能基准。

新增能力先以缺失方法/文件的失败测试确认未实现。面板测试最初将方向键和回车作为一个组件输入事件，修正为逐键输入后通过。类型检查修正了测试中的缺失 runtime stub 和 PermissionRequest 字段。真实 PTY 首次在连续输入后未打开管理器，修正为等待可见的入队反馈；下一轮流式首段就绪判断不稳定，改用服务端请求已到达的条件后，整个流程通过。共两轮 PTY 修正，未提高等待上限绕过失败。

代码审阅包含队列保护变异验证：临时移除暂停派发判断，测试因待发条目已被执行而失败，同时触发测试清理期间取消拒绝；恢复原判断后队列和核心回归通过。变异未保留。

## 边界

仅普通 TUI，原生 terminal_start 后台终端与当前父会话直接子 agent。没有管理任意 OS 进程或后台 Shell 的承诺。记录驻内存、有界保留，重启不恢复队列或运行管理列表；子会话持久历史仍在 /sessions。steering 队列、嵌套任务树、附着客户端、强制停止/进程树核对另列 TODO。停止信号被忽略时保持 stopping。真实账号、长时间运行和大输出性能未验收。
