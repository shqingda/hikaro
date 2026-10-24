# 最低 Node 与生产依赖验收（2026-10-21）

> 后续状态：本记录中的“尚未修复”是当时结论。2026-10-21 后续已完成 Node 安全回移、上游兼容和分发安装验收，见 [当前记录](forge-backport.md)；原始 registry 告警仍保留。

## 最低版本通过

从 https://nodejs.org/dist/v24.21.0/ 下载 darwin-arm64 归档，按同站 SHASUMS256.txt 校验。归档 SHA-256：`bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`。只解压至 artifacts/node-minimum，不改变系统 Node。

通过 PATH 选择官方 Node 24.21.0，check-release 新增断言：PATH 中 node 的实际路径必须与当前进程一致，以覆盖 npm 和 bin shebang 子进程。对现有候选 SHA `a1f1cda32c0049a039ba14f5a9ad33053c4b75abd1670b1d167685008b288d96` 完成空缓存安装、离线任务、原生文件读取、安装目录 node-pty 的 TUI 启停，均通过。[原始报告](node-minimum.json)。这是最低版本运行/安装验证，不代表所有功能或源码工具链已在 Node 24 验收。

## 生产依赖安全未通过

原生 `pnpm audit --prod --json` 扫描工作区锁文件：2 high、1 moderate；uuid 与 braces 路径来自移动端，node-forge 同时进入根 TUI 和移动端。[工作区摘要](workspace-production-audit.json)。

对实际 tarball 中 package.json 与 npm-shrinkwrap.json 执行 npm audit --omit=dev，报告 2 high：node-forge 及其依赖上游 sandbox-runtime。两条均归因于同一个 [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)，不是两项独立漏洞。[完整产物审计](production-audit.json)。公告影响 <=1.4.0，当前 npm 最新 node-forge 为 1.4.0，无已发布修复；最新 sandbox-runtime 0.0.81 仍依赖 ^1.4.0，因此没有无效升级或降级。

局部源码检查显示 sandbox-runtime 使用 forge 构造/解析证书，签名使用 Node crypto；未据此豁免公告，因为这不是完整可达性证明。未改写密码学实现、未删除沙箱、未加入忽略列表。后续需等待/核对上游正式修复，或独立完成完整可达性分析与有据的风险处置，不能宣称依赖安全通过。

## 可重复门禁

新增 `pnpm audit:release ARTIFACT.tgz`：校验包 SHA，直接读取包内生产锁文件进行审计，报告绑定产物 SHA 和时间。high/critical 非零即失败，审计服务失败或结果缺失也失败；低/中危仍显式保留供处理。

release:pack 在生产锁生成后、npm pack 前执行同一审计。定向单测通过；真实门禁运行按预期退出 1 并明确阻断高危依赖，未覆盖旧候选包（SHA 已复核不变）。发布门禁测试通过与产品依赖安全通过是两回事。本轮提交的是最低版本证据与阻断逻辑，不是安全修复或发布批准。

本轮构建通过，变更脚本语法和 diff 检查通过；未修改产品 TypeScript，未跑全量测试。TUI 92%、移动端 35%，均未到 95%；安全项仍为 release 阻塞。
