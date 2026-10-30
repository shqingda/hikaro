# 干净 macOS 分发验收

## 首次远程构建：f5be028

[GitHub Actions 39589665410](https://github.com/shqingda/hikaro/actions/runs/39589665410) 通过。macOS 14.8.9 arm64 新 VM、最低 Node 24.21.0、空 pnpm store；类型检查、3 项发布/安全契约测试、构建、生产安全门禁、空 npm 缓存安装、包内原生 helper 与 TUI 启动/退出均通过。产物 SHA-256：`86bb1bde6da752f54aca81a0a4303cfd75787b757db138d46c398972cf443961`。

使用标准 macos-14 arm64 runner，选择依据为 [GitHub 官方 runner 参考](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。Actions 固定 commit，仓库权限只读；不调用既有全量 check 工作流。原始 runner 含开发工具，这不等同没有 Xcode Command Line Tools 的用户机器。

## 同包订阅验收发现与修复

将上述同一 tarball 取回 macOS 27.0.1 / Node 26.12.0 后，模型首个 read_file 猜测工作区外绝对路径，触发审批；未自动批准，验收在原 120 秒期限结束。安装和原生 helper 没有证据表明故障；问题是系统提示未提供当前会话工作目录。失败记录保留于本机 artifacts/live-release-EvmHGK/report.json。

Runtime 现将会话实际 cwd 作为 JSON 字符串提供给模型，并说明相对路径归属；不更改外部访问审批。新增两个定向回归先在旧代码失败、修复后通过，包括带引号/换行的目录。类型检查、构建通过。工作区专用验收阶段遇到意外审批会立即报告，不再一直等结束；没有扩大权限或延长超时。

## 修复后的同包验收：b08f160

[GitHub Actions 39590723969](https://github.com/shqingda/hikaro/actions/runs/39590723969) 全部通过，另包含上述 2 项工作区上下文回归。候选来自干净工作树 `b08f160dd8c047d9f41857222d6478afc2ed78e4`，SHA-256：`288294efffbdd42aaae6356602172b13cdcf0fa5f1bbeca6a7a67a4c5a6b6a1d`。

- macOS 14.8.9 arm64 / Node 24.21.0 的[空缓存安装与包内 TUI 记录](release-ci-install.json)通过。
- 将同一 tarball 取回 macOS 27.0.1 / Node 26.12.0，再从空缓存安装，执行[实际订阅完整记录](release-ci-subscription.json)：读/改/测/diff、拒绝、取消、host SIGKILL、4 类网络故障与明确继续全部通过。
- 首次模型猜错路径的失败记录保留。没有放宽审批、断言、超时，也没有用源码调用替代候选包调用。

## 分发草稿

[Hikaro TUI 0.1.0 候选草稿](https://github.com/shqingda/hikaro/releases) 当时创建于现有私有仓库，目标为 b08f160，仍为 draft。包含 tarball、SHA-256、生产审计、manifest、CI 安装和真实订阅验收报告。GitHub 当时记录的 tarball 摘要与上述测试对象一致。

通过 `gh release download v0.1.0` 重新下载附件，`shasum -a 256 -c` 通过；本机保留于 artifacts/release-download-b08f160。正式渠道取回的字节与已安装实测的候选一致，没有为重复字节再跑一次相同模型测试。

当时正式发布仍待人工草稿复验、辅助技术和最终发布确认。没有更改仓库可见性，也没有发布正式版本。完整功能目标仍按 tasks/todo.md 推进。

后续：用户已经确认五项物理终端检查全部通过；[cf57c46 新候选](release-recovery.md)又通过了干净最低 Node 安装、草稿及 steering 恢复，并对该新 SHA 完成实际订阅复验。分发草稿与七个附件已更新到 cf57c46，下载后字节一致；b08f160 的历史报告仍保留在本记录中，没有用它证明新包通过。
