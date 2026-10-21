# 恢复修复进入分发包 · 2026-10-21

本轮将 7446011 的 steering 持久恢复与已有 Ctrl+D 草稿修复纳入实际 tarball 安装验收。唯一 E2E 为 `pnpm check:release ARTIFACT.tgz`，应用、worker、node-pty 和工具均来自安装目录；源码 SharedHostClient 仅用作观察传输，不使用源码 Runtime。

新增检查覆盖：立即退出前最后一段多行中英文/emoji 草稿保存、`--continue` 重开保留原文、SIGKILL 后两条补充指令恢复为待确认、附着 TUI 只确认其中一条而不启动任务、明确新请求仅应用已确认项一次，另一条仍保留。主流程继续检查空 npm 缓存安装、包内原生 helper、生产安全补丁全源码一致性和 8 组签名回归。

本机 macOS arm64 / Node 26.12.0 首次执行通过，包 SHA-256 `178737523dd991898cc70abbbc4e8894e539b81b99bed66150e18f55b5413d84`；本机 manifest 标记 dirty，因为打包时验收脚本与文档还未提交，不能冒充干净 CI 来源。新 helper 和入口语法检查通过，打包重新构建并执行安全门禁。没有增加依赖或运行其他 E2E、全量测试、性能基准。

干净 macOS 最低 Node CI 待执行，成功后以其 manifest / 安装报告绑定正式候选的 SHA。此前 b08f160 分发草稿暂保持原样，不混用旧订阅报告证明新包通过。此检查使用 demo provider，不替代真实订阅或物理输入法；用户五项人工结果单独见[物理终端记录](physical-terminal.md)。
