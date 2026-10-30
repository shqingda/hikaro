# node-forge 官方版本迁移 · 2026-10-30

源码安装和 npm 发行候选已固定为官方 `node-forge 1.4.2`，原 `1.4.0` RSA 回补、`patches/`、反向恢复旧源码的测试机制及公告放行逻辑全部退役。

## 上游依据

- [官方安全公告](https://github.com/digitalbazaar/forge/security/advisories/GHSA-2g46-22mc-6gwp) 确认 `1.4.1` 修复嵌套 DigestAlgorithm 问题；正式实现还拒绝非规范 DigestInfo 编码，不只是增加元素数量检查。
- [官方 v1.4.2 变更记录](https://github.com/digitalbazaar/forge/blob/v1.4.2/CHANGELOG.md) 记录 `2026-10-27` 发布，并恢复 `1.4.1` PEM 安全修复后的 Buffer 输入兼容。
- npm registry 查询确认 `latest=1.4.2`；`sandbox-runtime 0.0.81` 的依赖范围 `^1.4.0` 接受此版本。
- 官方 tarball：`https://registry.npmjs.org/node-forge/-/node-forge-1.4.2.tgz`。
- tarball SHA-512：`sha512-rRtAR5XLJ8gCKd9du4qrKAsgCG1ObGP4gLeNJMa4vYSeq4bmBMOJk5IHkrviBV0q7uoAJlVd8HEQYQSVUb4FGQ==`。

## 完整性与审计门禁

下载官方 tarball 后先校验上述 SHA-512，再逐文件计算 SHA-256，形成 [固定发行证明](../../scripts/security/node-forge-1.4.2.json)。清单覆盖 49 个 Node 源文件，以及 package.json、README、LICENSE 共 52 个文件。`dist/`、`flash/` 的 7 个非 Node 文件是明确裁剪项，不声称发行包逐字等于完整上游 tarball。

`forge-release.mjs` 对实际依赖位置核验精确文件集合、普通文件类型和逐文件哈希；校验入口、版本和 exports。生产 shrinkwrap 必须只有一份 forge，且版本、官方 tarball URL、integrity 与证明一致。发布包继续拒绝缺失、额外、重复和嵌套 forge 条目，安装后再次核验。Node 源码不再经过文本替换，安装也不依赖补丁生命周期脚本。

`release-audit.mjs` 保留原始 npm audit，不再有 `assessPatchedAudit` 或 `remediations` 放行路径。high/critical、缺少有效审计结果、内容校验失败均阻断发布；仅把包内容从旧回补证明切换为官方发行证明，没有降低门槛。

## 回归验证

- 升级前新增用例在原 `1.4.0 + 回补` 上失败：它仍接受 NULL 内容等非规范 DER。升级后通过。
- 8 组 SHA-1/SHA-256/SHA-384/SHA-512 × 有/无 NULL：合法签名接受，额外嵌套元素拒绝，Node crypto 对照拒绝畸形签名。
- 3 类额外拒绝用例：带内容 NULL、非最小长度编码、非规范 OID。使用独立的固定 DER 编码与 Node 私钥操作构造测试输入，不通过改写第三方源码制造基线。
- PEM Buffer：`pem.decode()`、公钥与私钥 PEM 解析兼容。密钥仅由测试临时生成，不保存或输出。
- 发布验证器继续拒绝改写、缺失、额外文件、异常入口、软链接/目录冒充代码、重复归档项、嵌套副本和错误的生产锁完整性值。
- 11 项相关脚本测试通过；沙箱及 forge 可达性 3 项测试通过。
- 独立临时目录执行 `pnpm install --frozen-lockfile --prod --ignore-scripts --filter hikaro`，随后从实际 sandbox-runtime 位置执行官方内容、签名及 PEM 检查，通过。
- 工作区 `pnpm audit --prod --json`：0 high、0 critical；保留一项无关的 `qs 6.16.0` moderate，未扩大本次依赖变更范围。

## 最终候选包验证

工作台主实现提交为 `90489d85962ab1a3b9ec87c000da0e37408f5826`。最终候选 [hikaro-0.3.0-darwin-arm64.tgz](../../artifacts/release/hikaro-0.3.0-darwin-arm64.tgz) 的 SHA-256 为 `02ad67500bf56e9bdcdefed3dbf92b4235e928f2ff27177487c865eb7269d64d`，压缩大小 8,088,416 字节。打包时 `dirty=true`，剩余变更为任务清单和工作台验证记录，不能将候选描述为干净提交产物。

最终一次运行结果：

- `node scripts/package-release.mjs` 通过；staging 与包内原始 npm audit 均为零漏洞，52 个保留文件、官方来源及生产锁核验通过。
- `pnpm check:release artifacts/release/hikaro-0.3.0-darwin-arm64.tgz` 完整通过。空缓存安装、forge 内容和签名/DER/Buffer、bin、离线 prompt、原生 helper、实际 PTY 启动退出，以及立即 Ctrl+D 多行草稿恢复、host SIGKILL 后显式恢复且只消费一次、完整 Unicode diff 分页与磁盘不变检查均通过。[机器报告](../../artifacts/release/hikaro-0.3.0-darwin-arm64.tgz.validation.json) 绑定同一 SHA。
- `pnpm check:install` 通过：独立复制已跟踪源码，安装、类型检查、原生构建和真实 TUI 启动退出成功。
- 独立临时目录重新执行 `pnpm install --frozen-lockfile --prod --ignore-scripts --filter hikaro`，实际 sandbox-runtime 所解析的 forge 通过官方完整性与全部签名/DER/Buffer 检查，临时目录已清理。
- 最终工作区生产 audit 仍为 0 high、0 critical、1 项 `qs` moderate；没有新增审计例外。pnpm 的非零退出码来自该 moderate，不将其表述为零漏洞。

此前切片候选曾暴露 `Runtime is closing` 早退出竞态；最终候选的完整安装验收已验证修复。此记录只证明上述候选及检查，不覆盖整个仓库的其他检查结果。

未执行公开发布、签名/公证或真实 provider 调用。本记录不替代物理终端中文 IME、鼠标及滚动验收。
