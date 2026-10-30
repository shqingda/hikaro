# 共享任务主机：启动、附着与恢复

共享主机通过经过认证的本地 Unix socket 为多个 TUI 提供同一个 Runtime、SQLite 和工具执行环境。

```sh
pnpm build
# 终端 1
pnpm start --host --demo --cwd /path/to/project
# 终端 2
pnpm start --attach --cwd /path/to/project
```

所有终端使用相同的 `--cwd` 和 `--home`。模型、端点及权限在主机上配置。`--client-id` 指定附着视图身份，默认 `main`；多个视图应使用不同身份。

Ctrl+D 断开视图，主机中的任务继续执行。重新附着恢复会话、草稿和待审批操作；未知结果通过持久回执查询，不自动重发。主机退出会中断运行，需要显式重新启动。普通 `pnpm start` 启动独立 TUI，不会自动安装后台服务。

主机描述文件和 socket 使用本机用户私有权限。重复主机、错误目录、无效凭据和不安全的 socket 会被拒绝。
