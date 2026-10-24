# 终端停止终态验收 · 2026-10-20

## 原因与修复

原实现只停止 PTY 主进程，忽略信号的子进程仍可能存活。现在停止 PTY 进程组，先 SIGTERM，最多等待 1 秒后 SIGKILL，再限时等待 2 秒。只有退出事件和进程组消失均确认才显示 exited；失败显示 stop_failed、原因和重试入口。保留退出码、信号及清理状态，插件关闭等待清理。

前轮失败的诊断补充：并行定向测试时，已收到 exitCode=0、signal=15 后，进程组存在性探测返回 kill EPERM。单独运行原终端用例通过。EPERM 不代表组已消失，也不能凭此立即断言停止失败；现在对存在性探测继续有界等待，只有 ESRCH 确认消失。实际发送停止信号的权限错误仍明确失败。

PTY 队列超时来自普通 TUI 在 agent.prompt 的异步入队完成前立即读 pendingPrompts，导致未显示已排队提示。改用 enqueuePrompt 等待持久化接受，再读取数量，并继续等待独立的 completion。

## 验证

- 诊断阶段：execution-terminal 单独运行通过；与另两个终端用例一起运行时失败，增强断言保留了具体 EPERM 证据。
- 修复后：terminal-stop-outcomes、execution-terminal、terminal-cancellation、execution-control-pty 四个文件共 4 个用例通过。
- 补充真实终端的权限失败/重试覆盖后：terminal-stop-outcomes 共 2 个用例通过。合计 5 个不同用例。
- pnpm typecheck、pnpm build 通过。
- 唯一 PTY E2E 覆盖排队删除/编辑、终端输入/退出、子 agent 取消及队列恢复执行。未降低断言或增加超时。

环境 macOS，本地 SSE fixture，不是真实模型账号验收。未运行全量测试、其他 E2E、性能基准或移动端真机验收。自行 setsid 脱离原进程组的 daemon 不在进程组清理保证内；host 被 SIGKILL 后的后台进程接管仍不在本轮范围。
