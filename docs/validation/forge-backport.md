# node-forge Node 安全回移验收 · 2026-10-21

TUI 中 GHSA-86w9-cpqp-85rv 的修复已落地并通过本轮验收；这不是官方已发布修复版本，也不是零漏洞审计声明。真实模型、物理终端交互与正式分发仍需完成。

## 修复与边界

基于 [上游 PR #1152](https://github.com/digitalbazaar/forge/pull/1152)，固定提交 `ceba34402e329f0365134f23fe19898756527d65`。上游仍未合并，node-forge 版本保持 1.4.0。回移只增加 RSA PKCS#1 v1.5 的嵌套 DigestAlgorithm 元素数量检查，允许 OID 与可选 NULL，拒绝额外字段。未删除沙箱、替换密码学库、改版本号、设置 audit 忽略项或放宽 severity。

- 源码：pnpm patchedDependencies + 锁文件固定补丁；独立目录 frozen-lockfile、生产依赖、禁用生命周期脚本安装通过。
- 分发：npm pack 捆绑 sandbox-runtime 及其 forge 依赖树；打包前从原始 rsa.js 哈希确认输入，补丁结果必须与源码安装的哈希相同。无需 postinstall 再打补丁。
- 完整性：49 个 lib 源文件逐项核验，不只检查版本号或一行补丁。包内额外 forge 副本、重复条目、文件篡改、缺失文件不能通过校验。

原始 rsa.js SHA-256：`fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50`。
修复后：`447c5441cea1b125e23661d7e27a8b1759cc3400241c0013b2d034b4ee1dbf50`。
完整清单：[49 个 Node 文件哈希](../../patches/node-forge-1.4.0.json)。

## 上游兼容回归

固定 v1.4.0 对应提交 `fa385f92440879601240020f158bed68e444e83a`，只替换修复后的 lib/rsa.js 和上述 PR 的 tests/unit/rsa.js。发现上游 tests/unit/jsbn.js 有 describe.only，直接执行入口只跑 5 个测试；在临时副本移除此筛选后运行完整 Node 测试入口，没有删除测试或断言。

使用独立 runner 安装 mocha@5.2.0（禁用安装脚本；测试工具不进入产品依赖）：

```sh
NODE_ENV=test node ../runner/node_modules/mocha/bin/mocha -t 30000 tests/unit/index.js --reporter json
```

Node 24.21.0 / 26.12.0 各 38 suites、829 passing、4 pending、0 failing。4 项是上游已有的 512-bit RSA PRNG pending，名称保留在报告；嵌套 DigestAlgorithm 新回归确实执行通过。测试目录的 49 个实现文件也与产品补丁清单核验一致。

本项目另有 8 组 sha1/sha256/sha384/sha512 × 有/无 NULL 回归：正常签名接受、额外字段拒绝；原版对照会错误接受、Node 原生校验拒绝。对照使用临时副本还原并检查原始哈希，不修改安装目录。该回归同时在最终安装目录实际解析到的 forge 上执行通过。

## 分发与安装验收

候选 tarball SHA-256：`003976229d04334bc1d873f843ba93e5883405ccf548e92f7a48cc696eee6dc5`。

最低 Node 24.21.0、独立安装前缀、空 npm 缓存：engine-strict 安装、49 文件补丁核验、8 组签名回归、实际 --version、离线任务、原生读取 helper、真实 node-pty TUI 启动及 Ctrl+D 正常退出全部通过。独立的 npm --ignore-scripts 安装也通过补丁核验；修复不依赖生命周期脚本。当前 npm 策略提示部分原生安装脚本尚未批准，本机仍通过上述运行验证；不代表其他环境无需安装脚本。

类型检查与构建通过。仅运行受影响的本项目定向单测和一个发布安装 E2E；未运行本项目全量测试或性能基准。上游 Node 库兼容测试是本次安全回移的专门验收，不替代真实模型和物理终端验证。

## 审计处置

原始 npm audit 继续报告 2 high 依赖节点（同一个公告：forge 和 sandbox-runtime），`registryPassed` 明确为 false。发布检查只在以下证据齐全时记录已修复：恰好是该公告和传播链、所有报告位置的 Node 文件符合固定哈希、分发包不存在旧浏览器实现。新增高危公告、未知传播链、额外副本或任何校验缺失仍阻断；原始 audit 原文保留在报告。

后续上游发布官方修复时，应移除回移、更新锁文件并重跑兼容/分发/安装验收，不能简单删除哈希校验。新版本或新公告导致当前严格门禁失败是预期行为。

证据：[兼容与安装报告](forge-backport.json)、[原始产物审计及修复证明](forge-backport-audit.json)。候选由本轮未提交工作区构建，报告绑定实际 SHA；没有声称产物来自已签名的正式 tag。未公开发布，未完成签名、公证、无开发工具新机、真实 provider/Keychain 或人工 IME 验收。
