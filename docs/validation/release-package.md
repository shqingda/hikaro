# macOS arm64 候选包安装验收（2026-10-21）

已实现 `pnpm release:pack` 与 `pnpm check:release ARTIFACT.tgz`。前者重新构建当前源码，按平台打包 CLI、worker、原生文件 helper、生产依赖锁与 npm bin 入口，生成 SHA-256 和来源 manifest；private=true 防止候选误发布。后者使用临时安装目录、空 npm 缓存和独立数据目录验证真实 tarball，而非工作区源码。

最终产物：hikaro-0.1.0-darwin-arm64.tgz，约 904 KiB；SHA-256 为 `a1f1cda32c0049a039ba14f5a9ad33053c4b75abd1670b1d167685008b288d96`。原始结果见 [JSON](release-package.json)。产物位于 artifacts/release，不将二进制包提交进 Git；推送的是生成/验证脚本与证据，不是公开发布。

通过项：清单定向单测、构建、脚本语法/差异检查、SHA 校验、空缓存 npm 安装、安装后 bin 的离线任务、安装后原生 helper 读取、安装目录 node-pty 的真实 TUI 就绪与 Ctrl+D 正常退出。只运行一个受影响安装/PTY 验证脚本（修正后复验），未运行全量测试或性能基准；没有修改产品 TypeScript。

首次检查发现 npm 文件白名单遗漏 shrinkwrap，现显式包含并在打包结果中断言；首次原生读取因临时目录经过 /var 符号链接被安全助手拒绝，测试改用 realpath，不放宽文件安全限制。最终对应上面 SHA 的包完整通过。

边界：macOS arm64、Node 26.12.0 开发机；空缓存联网下载不等于无开发工具的新机器。Node 24 最低版本、其他系统/架构、真实模型及 Keychain、Gatekeeper 隔离下载与签名/公证、公开下载渠道、完整生产依赖安全审计仍待验证。npm 输出 node-domexception 弃用及安装脚本审批提示，已保留说明，未全局更改审批设置。生产依赖在每次打包时解析后锁定，重打包可能产生新的依赖版本和 SHA，必须重新验收；不能用旧证据覆盖新包。

TUI 92%，移动端 35%，未到 95%。
