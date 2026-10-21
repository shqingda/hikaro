# 实际分发包的订阅模型与恢复验收 · 2026-10-21

通过对象是 `db64b8102df3d576d30e3c276c9e985835d98337` 的 macOS arm64 候选包，版本 0.1.0，Node v26.12.0。SHA-256：`ca314cd01f7937411cd781b64be691dfee96277ebbe5415f384f837f40f9daad`。完整机器记录见 [JSON](live-release.json)。

运行 `node --import tsx scripts/check-live-release.mjs artifacts/release/hikaro-0.1.0-darwin-arm64.tgz`。脚本空缓存安装 tarball，校验 49 个 node-forge Node 源文件及 8 组签名回归；从安装目录加载 node-pty，实际运行安装的 host 与 TUI。源码 SharedHostClient 仅作为观察连接，模型/provider/tool 实现来自安装包。

使用正常 `~/.hikaro` Keychain 订阅登录，子进程移除 XAI_API_KEY，不提取或复制令牌。测试使用新工作区和新会话，host 自己执行 OAuth 读取和刷新。结束后清除临时安装与 npm 缓存，保留小型工作区、会话和报告。

## 已通过

1. PTY 输入实际发送给 xai/grok-4.7：read_file ×2、edit_file、shell、git_diff，运行完成。模型执行 `node --test sum.test.cjs` 成功；独立重跑测试也通过。测试源码和 package.json 未变，只有 sum.cjs 修改，无额外文件。最终答复显示在 TUI。
2. 从 TUI 发起 unrestricted shell，再按 Esc 拒绝；未产生目标文件，运行明确失败。
3. 真实模型启动长时间 shell，核对其 PID 存活；TUI Ctrl+C 后核对 cancelled 终态及该进程消失。
4. 真实模型请求 unrestricted shell，审批尚未通过时 SIGKILL host；重启并等待租约自然过期后，同一 runId 为 unknown、无活跃审批、没有目标文件。随后从原 TUI 明确发送新消息，真实订阅回复成功；未批准的命令始终未执行。
5. TUI Ctrl+D 正常退出。

第一次运行在模型闭环完成后失败：安全签名检查把自己的 JSON 报告写进了测试工作区，触发“无额外文件”断言。将签名检查的 cwd 改为验收父目录后重跑通过；没有删除或放宽断言。失败报告保留在本机 artifacts/live-release-iLLaG4/report.json，成功报告位于 artifacts/live-release-v8PFo2/report.json。

## 物理终端反馈与草稿修复

用户明确反馈输入法回车、中英文/emoji 编辑、两行粘贴和缩窄/恢复窗口四项正常。第 5 项期望：输入但不发送，Ctrl+D 退出，打开同一会话时草稿保留。代码此前仅在主编辑器为空时接受 Ctrl+D，和使用说明不一致。

已修改普通 TUI：主编辑器有内容时也处理 Ctrl+D，走原有草稿 flush 和退出流程；审批、模型/会话面板及扩展输入框保留各自输入处理。新增定向交互断言先在旧代码失败，修复后通过；唯一受影响 PTY 用例保留 SIGKILL 恢复和提交清理，增加 `--demo --continue` 与“追加文字后立即 Ctrl+D”的退出/重开检查。两项定向测试通过。该修复晚于上述 tarball，不能用旧 SHA 的报告声称新包已经验收。

## 待验收

草稿修复后 `pnpm typecheck` 与 `pnpm build` 均通过，当前本机 dist 已更新供物理终端复验。没有运行全量测试或重复性能基准。

第 5 项用户复验、终端/输入法版本记录、真实物理辅助技术；provider 断网/限流分支；加入最新修复后的最终候选包和干净机器/正式渠道。PTY 不证明系统输入法处理；注入故障也不能描述为真实外部服务故障。

本轮达到 TUI 发布准备估算 95%，移动端维持 45%，已通知用户。完整功能目标和正式 release 均未标记完成。
