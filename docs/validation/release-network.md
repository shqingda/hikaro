# 分发包网络恢复验收 · 2026-10-21

状态：通过。完整机器报告见 [JSON](release-network.json)。候选包 SHA-256 为 `a48ac1e7cb78dc8d1793d345cb21f33be50368826634f0821f5dac43da268e06`；基于 `997d25a`，包含 Ctrl+D 草稿修复。打包时工作树另有验收脚本/计划修改，因此 manifest 如实记录 dirty=true；这些脚本不进入发布包。

本轮唯一 E2E 是 `node --import tsx scripts/check-live-release.mjs artifacts/release/hikaro-0.1.0-darwin-arm64.tgz`。空缓存安装后，先复核上一轮订阅读改测、拒绝、取消和 SIGKILL 恢复，再执行下列场景。

| 注入场景 | 实际观察 | 恢复 |
| --- | --- | --- |
| 请求前 ENETUNREACH | failed，TUI 显示 Connection error，busy=false | 明确发送新消息后，真实订阅模型 completed |
| HTTP 429 | failed，TUI 显示注入的限流错误，busy=false | 明确发送新消息后，真实订阅模型 completed |
| 实际回复中途断流 | 接收真实 xAI 回复的 text delta 后中断流，failed，TUI 显示断流错误 | 明确发送新消息后，真实订阅模型 completed |
| 请求挂起后 Ctrl+C | 传输收到 AbortSignal，cancelled，TUI 显示 Stopped，busy=false | 明确发送新消息后，真实订阅模型 completed |

每种故障只有一次模型传输调用，没有自动重试；每个场景只产生故障运行和明确恢复运行两个 run.start，没有工具执行。故障文件仅对启动验收 host 时的 `node --import` 生效，只匹配 `https://api.x.ai/v1/responses` 的 POST。登录、token 刷新、其他接口和用户系统网络不受影响。trace 只记录模式/阶段，不记录 URL、请求内容、响应内容、头或令牌。

这是进程内故障注入加真实订阅恢复，不是故意触发账号限额，也不宣称实际服务发生了故障。4 项注入模块单测覆盖接口隔离、无网络的离线/429、挂起取消和真实流包装的关闭；全部通过。新候选包构建与安全门禁通过。未运行全量测试或性能基准。

仍待：用户第 5 项草稿复验、干净机器安装、最后分发渠道与发布验收。
