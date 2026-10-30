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

## 候选包验证边界

该切片候选包 SHA-256 为 `1249205cfe7884c6c76be89b8c7b508a8315800426563dfcccea949c393ea921`，来源是 `e5c8e319ddb4e10241164b2ac5b3affc03bacef0` 上的未提交工作区。真实打包完成，打包前及包内原始 npm audit 均为零漏洞，49 个 Node 文件和生产锁核验通过。

空缓存 `check:release` 已通过 forge 完整性、签名/PEM、bin、离线 prompt 与原生 helper 验收；随后 TUI 立即 Ctrl+D 退出暴露启动/关闭竞态，返回 `hikaro: Runtime is closing`。此时整条安装 E2E 尚未通过，不把上述局部成功声明为正式发布就绪。最终集成需要修复该竞态并重新打包、运行完整安装验收；源码变化和文档变化后的新包须绑定新的 SHA。

未执行公开发布、签名/公证或真实 provider 调用。本记录不替代物理终端中文 IME、鼠标及滚动验收。
