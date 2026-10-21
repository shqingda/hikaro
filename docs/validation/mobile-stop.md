# 移动端按运行停止 · 2026-10-21

## 实现

手机系统确认框捕获任务与运行 ID。`run.cancel` 是可协商的新能力：host 认领持久命令后再次验证选择和控制权，同步检查目标运行并取消该任务；不会取消其他任务，也不向旧 host 降级发送范围更大的 `cancel`。回执保留运行 ID，运行终态只采用 host 事件/快照。完整契约见 [规格](../specs/mobile-stop.md)。

## 验证

- `tests/rpc-control.test.ts`：20 项通过，包含新目标竞态、已结束/错任务拒绝、普通请求阻塞期间仍可停止及单次回执结算；保留旧取消、审批、容量和归属断言。
- `tests/mobile-controller.test.ts`：8 项通过，包含旧确认拒绝、重复点击保护、旧 host 不降级、收到回执不伪造终态。
- 其中一个加密 fixture 接实际共享 host/SQLite 的集成流程：批准并运行真实 shell，记录活跃 PID；丢弃停止回复后确认进程退出、runStatus 为 cancelled；重连查询 completed 回执并核对 runId，停止帧只发送一次。随后启动新运行，手机与 host 分别拒绝旧 runId，新运行保持运行，明确停止新 runId 后才结束。
- `tests/client-connection.test.ts`：4 项通过，保留意图先持久化、跨连接丢弃迟到写入、旧 host 与连续回执回收回归。
- `pnpm mobile:typecheck`、`pnpm typecheck`、`pnpm build` 通过；iOS／Android Hermes 生产 JS 导出通过（4.3 MB／4.2 MB），日志 `artifacts/mobile-stop-export.log`。

## 发现与修复

旧 RPC 测试 mock 尚未补上现行 enqueuePrompt 接口，导致 5 项历史控制回归失败；补齐 mock 的接收/完成分离接口，原断言保持，通过复验。

实际 SQLite 集成发现新停止处理已结算回执后，通用返回路径又结算一次。增加 settled 门禁，并断言每个停止命令只结算一次；修复后原丢包/终态断言通过。没有放宽超时、权限或测试断言。

## 尚未完成

原生确认框点击、真实 relay 网络、真机生命周期和签名分发没有本轮新证据。此处的加密传输仍由 fixture 驱动，不代替这些验收。补充消息和持久离线草稿仍待实现。

工程估算：TUI 94%，移动端 45%；均未达到 95%。
