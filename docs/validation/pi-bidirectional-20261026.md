# Pi 双向长会话、取消与恢复 · 2026-10-26

首轮构建 `0d39fa5`，修复后重跑于本提交构建，本机 Pi 1.4.0、Node 26.12.1、macOS arm64。全部在临时 Pi 配置、Hikaro home 和工作区中运行，不接触个人数据，不使用真实账号。脚本保存在 [pi-bidirectional-20261026/](pi-bidirectional-20261026/)，可用 `npx tsx` 重跑。

## Hikaro → Pi（`PiBackend` 经 `pi --mode rpc`）

模型是本机假的 OpenAI 兼容 SSE 服务（`fake-llm.mjs`），通过 Pi 的 `models.json` 接入；含 `slow` 的提示按 50 ms 间隔流出 200 段。

| 场景 | 结果 |
|---|---|
| 长会话 | 25 轮依次完成，Pi 会话 user/assistant 各 25 条（另有 Pi 自带 1 条 system），第 25 次请求带全部 25 轮历史 |
| 取消 | 流式第 5 段时排入一条跟进再取消：11 ms 内 `cancelled`，跟进未发出；下一轮正常完成 |
| 恢复 | 关闭进程后用同一 `--session-id` 重连，消息数不变（55），下一次请求带 28 轮历史 |
| 崩溃 | 运行中 SIGKILL Pi：提示被拒绝、`run.end` 为 `failed`；重连后会话保留（58 条）并能继续 |

## Pi → Hikaro（Pi TUI 中自动打开的 Hikaro 入口，demo provider，PTY）

首轮（`0d39fa5`）发现两处问题，修复后同一脚本连续三轮 5/5 通过：

| 场景 | 结果 |
|---|---|
| 长会话 | 15 轮在同一 Hikaro 会话内完成 |
| 取消 | 3000 字符回声流式中 Ctrl+C，约 42 ms 显示 Stopped，未输出完整回声，Pi 不退出，下一轮正常 |
| 返回与重开 | `/back` 后 Hikaro 子进程退出；`/hikaro` 接回同一会话并显示最近 20 条消息 |
| 崩溃 | 运行中 SIGKILL Hikaro 子进程：界面显示退出原因，底栏改为 `Not connected · Ctrl+D or /back returns to Pi`；草稿保留，草稿后输入 `/back` 返回 Pi；重开接回同一会话 |
| 崩溃后的租约 | 被杀进程的 30 秒会话租约不被抢占；首次提示显示 `Session is running elsewhere` 并退出 Working，租约过期后重发完成 |
| 重启 Pi | Pi 退出码 0；重启后自动进入并接回同一会话，全程只有 1 个 Hikaro 会话 |

## 修复

1. **接回上次会话。** 扩展按工作目录把最近的 Hikaro 会话 ID 记在 `pi-bridge.json` 的 `sessions`；打开时先 `session.resume` 并读取最近 20 条消息显示，失败（会话已删除等）才 `session.create`。设置文件读不了时只是不接回，不影响打开。
2. **断开后返回 Pi。** 断开时 Ctrl+D 不再要求输入框为空；保留的草稿后面输入 `/back` 或 `/quit` 会被识别为返回命令，草稿不提交。
3. **显示被拒绝的提示。** 测试中发现：提示被接受后若在运行开始前被拒（如租约未过期），RPC 只发 `error` 消息，视图原来不处理而一直显示 Working。现在显示错误并退出 Working；运行已开始时的错误只显示，不改状态。

`tests/pi-view.test.ts` 4 项先失败后通过；全量 139 个测试文件 746 项、脚本 19 项、`pi-smoke` 通过。
