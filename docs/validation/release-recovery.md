# 恢复修复进入分发包 · 2026-10-21

本轮将 7446011 的 steering 持久恢复与已有 Ctrl+D 草稿修复纳入实际 tarball 安装验收。唯一 E2E 为 `pnpm check:release ARTIFACT.tgz`，应用、worker、node-pty 和工具均来自安装目录；源码 SharedHostClient 仅用作观察传输，不使用源码 Runtime。

新增检查覆盖：立即退出前最后一段多行中英文/emoji 草稿保存、`--continue` 重开保留原文、SIGKILL 后两条补充指令恢复为待确认、附着 TUI 只确认其中一条而不启动任务、明确新请求仅应用已确认项一次，另一条仍保留。主流程继续检查空 npm 缓存安装、包内原生 helper、生产安全补丁全源码一致性和 8 组签名回归。

本机 macOS arm64 / Node 26.12.0 首次执行通过，包 SHA-256 `178737523dd991898cc70abbbc4e8894e539b81b99bed66150e18f55b5413d84`；本机 manifest 标记 dirty，因为打包时验收脚本与文档还未提交，不能冒充干净 CI 来源。新 helper 和入口语法检查通过，打包重新构建并执行安全门禁。没有增加依赖或运行其他 E2E、全量测试、性能基准。

## 干净机器结果

[GitHub Actions 39594606808](https://github.com/shqingda/hikaro/actions/runs/39594606808) 全部通过：macOS arm64 新 VM、最低 Node 24.21.0、空 pnpm store。类型检查、工作区上下文和 steering 定向测试、发布/安全契约、打包审计、空 npm 缓存安装及上述包内恢复检查全部成功。没有额外启动其他 E2E。

候选来自干净提交 `cf57c46d7e9da38bcbcca8c38e42668500543809`（manifest `dirty: false`），SHA-256 为 `4fc18e9c33251a7540c6d9c2dea0e337db84b75df0d7757784f7d91d49f6338d`。下载到本机 artifacts/ci-release-cf57c46 后 `shasum -a 256 -c` 通过；manifest 包含新增 `dist/pending-steering.mjs`，并与[CI 安装报告](release-recovery-install.json)的 SHA 相同。

此前 b08f160 分发草稿暂保持原样，不混用旧订阅报告证明新包通过。下一步对本次 CI 的同一 tarball 进行订阅模型验收，再更新分发草稿。此检查使用 demo provider，不替代真实订阅或物理输入法；用户五项人工结果单独见[物理终端记录](physical-terminal.md)。
