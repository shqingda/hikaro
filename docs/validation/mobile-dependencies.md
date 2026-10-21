# 移动构建依赖核查

2026-10-21。用户明确当前仅个人自用：构建工具链的已知上游漏洞记录为待修项，不自行维护补丁，也不单独阻塞自用交付。若将来公开分发或处理不可信构建配置，需要重新评估。此决定不等于所有漏洞已修复。

- uuid：Xcode 3.0.1 使用 v4，限定依赖覆盖到保留 CommonJS 的 11.1.1。原版越界缓冲区回归失败，升级后三项测试全部通过：v3/v5 在修改缓冲区前拒绝越界、Xcode 创建文件/分组并序列化解析、两条 Expo 路径的 forge 完整实现校验。最新审计中 uuid 告警消失。
- node-forge：Expo CLI 及 @expo/code-signing-certificates 均解析到仓库现有补丁；verifyForge 逐文件哈希通过。注册表仍按版本报告告警，未添加忽略规则。此证据覆盖 Node 构建路径，不声称验证了原生签名包。
- braces：Metro → metro-file-map → micromatch → braces 3.0.3。深层嵌套匹配规则可能耗尽递归调用栈。尚无上游修复版本，没有证据证明来自手机消息的运行时可达性；按用户自用范围保留上游待修，不阻塞试用。

验证：`node --test scripts/mobile-dependencies.test.mjs` 三项通过；mobile typecheck 与 iOS/Android Hermes export 通过。原始注册表审计保留 node-forge 与 braces 两项 high，未把原始审计描述为全绿。

来源：[uuid 公告](https://github.com/advisories/GHSA-w5hq-g745-h8pq)、[braces 公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)、[node-forge 公告](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。
