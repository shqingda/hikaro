# 后台终端停止终态

Unix PTY 使用 forkpty 创建独立会话/进程组。停止时发送进程组 SIGTERM；最多等待一秒，仍存在则发送 SIGKILL，并限时核对进程组消失。收到主进程 exit 不等于清理完成；必须同时确认退出事件与进程组清理后才显示 exited。失败显示 stop_failed 和原因，提供重新停止；正常停止请求保持 stopping。

保留实际退出码和信号，terminal_read 与 `/tasks` 使用同一状态。插件关闭等待所有停止结果，不能先清掉记录或把请求当成功。该范围不保证清理自行 setsid 脱离进程组的 daemon；不会扫描并杀死任意系统进程。

验证：真实子进程忽略 SIGTERM、主进程先退出的 terminal-stop-outcomes 测试；已有 execution-terminal/terminal-cancellation 定向用例；唯一 execution-control-pty 实际停止界面流程；类型检查与构建。
