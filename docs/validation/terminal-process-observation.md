# 后台终端后代观察 · 2026-10-24

## 结果与边界

macOS 后台 PTY 现在按父子关系观察后代，并用 PID + 启动时间持续核实身份。原始进程组停止或主进程自然退出后，已观察后代仍存活时显示 `descendants_running`；探针暂时失败显示 `descendants_unknown`，恢复后重新显示实际观察结果。二者仅供查看，既不提供控制按钮，也不向脱离进程组的 PID 发信号。原始进程组确认消失后不会再次向同一数字 PGID 发信号。

只保存最多 4,096 字符的观察摘要；旧数据库自动加列。重启后显示历史摘要及未知状态，不恢复 PID 控制。完整约束见 [终态规范](../specs/terminal-stop-outcomes.md)。

采样最多 256 个节点、16 层，单次超时 1 秒、输出 128 KiB；已知后代未确认消失时仍计入 8 个终端限额。每秒刷新只在观察摘要变化时通知存储。可能漏掉采样间创建并脱离的进程；非 macOS 探针明确不可用。前台 Shell 后续已完成[有界收尾与观察](foreground-process-boundary.md)；跨平台探针和长期占用测量仍待完成。

## 验证

- 原有进程组停止/权限失败/会话隔离覆盖保留。真实 Node detached 后代分别覆盖主动停止和主进程自然退出；先等待观察到 PID，再触发退出，确认后代存活且没有收到信号。
- 同一停止 fixture 注入一次 helper 失败，`terminal_read` 显示未知而非退出；恢复真实探针后再次显示存活。任务详情在两种状态都没有控制动作。
- 原生身份校验覆盖直属根与子进程、错误启动时间拒绝跟踪、非直属首次根、缺失 PID、参数及数量边界。macOS 实测；非 Apple C 分支只完成编译和 unsupported 输出检查，不冒称真实 Linux 验收。
- 原有持久化 fixture 扩展覆盖实际保存摘要、恢复历史标记、跨会话隔离；独立迁移用例覆盖旧库及摘要上限。
- 最终 `pnpm check`：124 个测试文件、642 项应用测试、15 项脚本检查通过，含 `execution-control-pty` 普通 TUI 入口。类型检查、构建、未使用绑定检查通过。
- 将新 `unresolved` 判断反转的 mutation 实验被故障回归准确拦截：应为未知却误报 `exited/running:false`。已恢复源文件并完成上述全量检查。

## 精简与审阅

原生构建复用已有编译/临时文件清理流程，纯重构单独提交 `a285486`。`terminal_read` 只计算一次详情，观察逻辑由独立职责模块持有，不扩展 runtime 集中编排。未增加依赖或通用进程管理框架。

删除本轮新增的纯模拟“状态映射无操作按钮”测试，将其断言并入真实后代和故障恢复流程；相同行为仍被验证，避免重复 fixture。保留普通/附着入口、权限、进程组失败、历史恢复和平台独立边界。独立审阅未发现产品阻塞，指出并修正安装验收的 TUI 提前退出竞争：必须等 TUI ready 与探针读取均成功后才退出。

## 候选包

干净代码提交 `e8802f40cb78279d8ac02bc434488b1e6d653e1d`，SHA-256 `4442661147cd0bb9e181d78c0593945ea196f0d2257cadd55874422dfea43492`。本机 macOS arm64 / Node 26.12.1，该候选已归档至 `artifacts/release/hikaro-0.2.1-darwin-arm64-e8802f4.tgz`；更新候选见[前台边界验收](foreground-process-boundary.md)。

[包来源](evidence-20261024/process-release-manifest.json)与[空缓存实际安装验收](evidence-20261024/process-release-install.json)：打包审计、原生文件读取、安装后的进程 helper 对直属 PTY 身份读取、TUI 启停及原有恢复场景全部通过。未公开发布。

上轮包已保存在本机 `artifacts/release/hikaro-0.2.1-darwin-arm64-7fbe09a.tgz`，SHA 不变。
