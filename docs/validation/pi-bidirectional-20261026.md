# Pi 双向长会话、取消与恢复 · 2026-10-26

构建 `0d39fa5`，本机 Pi 1.4.0、Node 26.12.1、macOS arm64。全部在临时 Pi 配置、Hikaro home 和工作区中运行，不接触个人数据，不使用真实账号。脚本保存在 [pi-bidirectional-20261026/](pi-bidirectional-20261026/)，可用 `npx tsx` 重跑。

## Hikaro → Pi（`PiBackend` 经 `pi --mode rpc`）

模型是本机假的 OpenAI 兼容 SSE 服务（`fake-llm.mjs`），通过 Pi 的 `models.json` 接入；含 `slow` 的提示按 50 ms 间隔流出 200 段。

| 场景 | 结果 |
|---|---|
| 长会话 | 25 轮依次完成，Pi 会话 user/assistant 各 25 条（另有 Pi 自带 1 条 system），第 25 次请求带全部 25 轮历史 |
| 取消 | 流式第 5 段时排入一条跟进再取消：11 ms 内 `cancelled`，跟进未发出；下一轮正常完成 |
| 恢复 | 关闭进程后用同一 `--session-id` 重连，消息数不变（55），下一次请求带 28 轮历史 |
| 崩溃 | 运行中 SIGKILL Pi：提示被拒绝、`run.end` 为 `failed`；重连后会话保留（58 条）并能继续 |

## Pi → Hikaro（Pi TUI 中自动打开的 Hikaro 入口，demo provider，PTY）

| 场景 | 结果 |
|---|---|
| 长会话 | 15 轮在同一 Hikaro 会话内完成 |
| 取消 | 3000 字符回声流式中 Ctrl+C，43 ms 显示 Stopped，未输出完整回声，Pi 不退出，下一轮正常 |
| 返回与重开 | `/back` 后 Hikaro 子进程退出；`/hikaro` 重开可用 |
| 崩溃 | 运行中 SIGKILL Hikaro 子进程：界面显示退出原因，Pi 不退出，断开时拒绝发送；重开可用 |
| 重启 Pi | Pi 退出码 0；重启后自动进入 Hikaro |

## 发现的问题（未修）

1. **每次打开都是新 Hikaro 会话。** 扩展每次打开都调用 `session.create`；`/back` 再进或重启 Pi 后看不到之前的对话（本轮共产生 4 个会话）。历史仍保存在 Hikaro home，可在独立 TUI 中 `/sessions` 找到。RPC 已有 `session.resume`。
2. **断开后 `/back` 出不去。** Hikaro 子进程退出后，提交的内容会放回输入框以保留草稿；之后再输入 `/back` 会拼成 `原内容/back`，再次被放回。只能用 Ctrl+C 返回 Pi（Ctrl+D 要求输入框为空），底栏仍提示 `/back`。

不覆盖：真实模型/账号、Pi 工具调用与审批经桥接往返、Pi 自身的 compaction、移动端。
