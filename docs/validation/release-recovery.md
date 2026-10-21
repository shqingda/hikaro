# 恢复修复进入分发包 · 2026-10-21

本轮将 7446011 的 steering 持久恢复与已有 Ctrl+D 草稿修复纳入实际 tarball 安装验收。唯一 E2E 为 `pnpm check:release ARTIFACT.tgz`，应用、worker、node-pty 和工具均来自安装目录；源码 SharedHostClient 仅用作观察传输，不使用源码 Runtime。

新增检查覆盖：立即退出前最后一段多行中英文/emoji 草稿保存、`--continue` 重开保留原文、SIGKILL 后两条补充指令恢复为待确认、附着 TUI 只确认其中一条而不启动任务、明确新请求仅应用已确认项一次，另一条仍保留。主流程继续检查空 npm 缓存安装、包内原生 helper、生产安全补丁全源码一致性和 8 组签名回归。

本机 macOS arm64 / Node 26.12.0 首次执行通过，包 SHA-256 `178737523dd991898cc70abbbc4e8894e539b81b99bed66150e18f55b5413d84`；本机 manifest 标记 dirty，因为打包时验收脚本与文档还未提交，不能冒充干净 CI 来源。新 helper 和入口语法检查通过，打包重新构建并执行安全门禁。没有增加依赖或运行其他 E2E、全量测试、性能基准。

## 干净机器结果

[GitHub Actions 39594606808](https://github.com/shqingda/hikaro/actions/runs/39594606808) 全部通过：macOS arm64 新 VM、最低 Node 24.21.0、空 pnpm store。类型检查、工作区上下文和 steering 定向测试、发布/安全契约、打包审计、空 npm 缓存安装及上述包内恢复检查全部成功。没有额外启动其他 E2E。

候选来自干净提交 `cf57c46d7e9da38bcbcca8c38e42668500543809`（manifest `dirty: false`），SHA-256 为 `4fc18e9c33251a7540c6d9c2dea0e337db84b75df0d7757784f7d91d49f6338d`。下载到本机 artifacts/ci-release-cf57c46 后 `shasum -a 256 -c` 通过；manifest 包含新增 `dist/pending-steering.mjs`，并与[CI 安装报告](release-recovery-install.json)的 SHA 相同。

安装阶段使用 demo provider，不替代真实订阅或物理输入法；用户五项人工结果单独见[物理终端记录](physical-terminal.md)。

## 同包订阅和分发更新

对上述相同 SHA 运行唯一 `node --import tsx scripts/check-live-release.mjs artifacts/ci-release-cf57c46/hikaro-0.1.0-darwin-arm64.tgz`，首次执行全部通过，见[本次订阅报告](release-recovery-subscription.json)。使用正常订阅 OAuth 登录，应用自己读取/刷新凭据，不要求 API Key、不复制或输出令牌。

真实模型完成读文件、修改、执行测试与 diff；脚本独立核对测试通过且无额外修改。拒绝审批未产生文件，Ctrl+C 后运行 cancelled 且真实 shell PID 消失。等待审批时 SIGKILL host，恢复后原 runId 为 unknown，未批准的命令未执行；明确新请求能继续。进程内断网、429、真实流中途截断、挂起取消四类故障均可见终止、不自动重发，各自后续订阅请求成功。没有修改系统网络、延长超时或重复跑安装 E2E/基准。

[0.1.0 分发草稿](https://github.com/shqingda/hikaro/releases/tag/untagged-21916d3e014efb690aca) 已更新到 cf57c46，仍为 draft，未更改仓库可见性。七个附件包括 tarball、校验和、manifest、原始生产审计、包内安全评估、最低 Node 安装报告及本次同包订阅报告。重新下载全部附件到 artifacts/release-download-cf57c46，七份文件逐字节与上传来源一致，tarball SHA 校验通过；旧包的订阅证据未冒充新包证据。

辅助技术与最终发布仍待完成，完整 TUI/移动端功能目标仍按 TODO 推进。本轮发布估算保持 TUI 98%、移动端 45%。
