# node-forge 可达性与候选修复（2026-10-21）

## 当前边界

TUI 的终端工具启动 packages/tools/src/sandbox-runner.mjs，唯一 sandbox-runtime 调用是固定配置的 initialize / wrapWithSandboxArgv / reset。allowedDomains 为空、不传用户配置、不启用 tlsTerminate/mitmProxy、不提供网络审批回调；普通沙箱命令不允许外连。显式 Full Access 是另外的已批准执行边界，不能用本结论为任意用户脚本背书。

sandbox-runtime 0.0.79 的 sandbox-manager 静态导入 mitm-ca，后者导入 node-forge，因此漏洞代码确实存在于依赖与进程内。createMitmCA 在 network.tlsTerminate 显式开启时才调用，当前 runner 未开启。已检查的 forge 用途是证书构造/解析；原生 Node crypto 负责证书签名。静态搜索未发现 sandbox-runtime 直接调用 forge RSA verify，但不能单凭搜索证明所有可达性。

## 动态证据

新增 forge-reachability 定向测试：预加载探针对实际 CommonJS exports 原地代理，任何 forge API 调用或构造均记录并抛错。代理确认被 ESM 消费；执行真实沙箱工作区读写成功、兄弟目录读取拒绝、本地 HTTP 请求拒绝（服务端请求计数 0），三个场景 calls=[]。独立正对照明确调用 sha256.create，探针正确记录并拒绝，避免把探针失效误报为不可达。初版替换 CommonJS cache 导出未覆盖 ESM 引用，已修正；别名 sha256/md.sha256 使用同一对象，记录其首次缓存别名。

结论仅为：当前固定沙箱配置与上述实测路径没有调用 forge API，未发现不可信输入进入受影响验证函数的路径。不是对整个进程、未来配置、插件或 Full Access 的永久不可达证明。生产包仍含受影响版本，审计门禁不变。

## 可行修复候选及限制

上游 [PR #1152](https://github.com/digitalbazaar/forge/pull/1152)（ceba344，查询时未合并）在已有外层 DigestInfo 检查之外，检查内层 DigestAlgorithm 只包含 OID 与可选参数。这是有明确缺陷对应的校验补丁，不是改名版本、删除依赖或忽略公告。

`node scripts/check-forge-fix.mjs` 只复制已安装 node-forge 1.4.0 到临时目录，对唯一匹配的源码位置应用候选条件。使用本地临时 RSA 测试密钥构造签名，验证 sha1/sha256/sha384/sha512 × 有/无 NULL 共 8 组：正常签名原版/候选都通过；额外嵌套字段的畸形签名原版接受，候选拒绝，Node crypto 对照也拒绝。[结果与源码哈希](forge-fix-evaluation.json)。这是解析缺陷回归，不声称完成无私钥伪造攻击验证，也不是完整密码学审计。

安全落地路径：优先采用上游正式修复；若必须先行回移，需固定来源和补丁哈希、补齐上游 RSA/证书兼容与异常 DER 回归、确保 pnpm 源码依赖和 npm 分发包使用同一修补内容，并独立核验安装后代码及行为。未完成这些前，不把孤立测试成功等同于生产修复；不得伪造版本让 audit 消失。当前没有改动生产依赖，release 仍阻断。

## 其他发布进展

新增 `hikaro --version`，版本来自 package.json，独立于应用初始化。构建测试移除懒加载应用入口后版本查询仍正常，证明不需启动模型、数据库或 UI。5 项构建测试、沙箱探针及正对照通过，类型检查与构建通过；Node 26 与最低 Node 24.21.0 都输出 hikaro 0.1.0。未重新生成被安全门禁阻断的候选包，不冒用旧包验收覆盖新构建。

TUI 92%、移动端 35%，未到 95%。本轮交付是调查证据、候选修复验证工具和版本查询，安全漏洞尚未在生产依赖中修复。
