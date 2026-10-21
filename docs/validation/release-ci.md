# 干净 macOS 分发验收

## 首次远程构建：f5be028

[GitHub Actions 39589665410](https://github.com/shqingda/hikaro/actions/runs/39589665410) 通过。macOS 14.8.9 arm64 新 VM、最低 Node 24.21.0、空 pnpm store；类型检查、3 项发布/安全契约测试、构建、生产安全门禁、空 npm 缓存安装、包内原生 helper 与 TUI 启动/退出均通过。产物 SHA-256：`86bb1bde6da752f54aca81a0a4303cfd75787b757db138d46c398972cf443961`。

使用标准 macos-14 arm64 runner，选择依据为 [GitHub 官方 runner 参考](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。Actions 固定 commit，仓库权限只读；不调用既有全量 check 工作流。原始 runner 含开发工具，这不等同没有 Xcode Command Line Tools 的用户机器。

## 同包订阅验收发现与修复

将上述同一 tarball 取回 macOS 27.0.1 / Node 26.12.0 后，模型首个 read_file 猜测工作区外绝对路径，触发审批；未自动批准，验收在原 120 秒期限结束。安装和原生 helper 没有证据表明故障；问题是系统提示未提供当前会话工作目录。失败记录保留于本机 artifacts/live-release-EvmHGK/report.json。

Runtime 现将会话实际 cwd 作为 JSON 字符串提供给模型，并说明相对路径归属；不更改外部访问审批。新增两个定向回归先在旧代码失败、修复后通过，包括带引号/换行的目录。类型检查、构建通过。工作区专用验收阶段遇到意外审批会立即报告，不再一直等结束；没有扩大权限或延长超时。

修复后的远程候选包及同包真实订阅结果待下轮记录。此时不把首次 CI 的安装通过等同最新版本完整通过。
