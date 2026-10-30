# 内存采样口径修正验收（2026-10-21）

本轮只验收测量工具，不宣称产品长期内存或 release 已通过。用户明确要求撤销无依据且重复计数的 RSS 合计门槛；来源及新口径见 [规范](../specs/shared-memory-soak.md)。

- 4 项定向检查通过：PSS/SwapPss 解析；墙钟/单调时钟采样间断；macOS 原生进程 footprint 读取及无效 PID 拒绝；RSS 不再影响启动预算且 200 ms/16 ms 时间门槛仍生效。
- 真实 PTY 短测：1 分钟预热 + 1 分钟测量，7 条任务完成，host/TUI 正常退出码均为 0。报告正确返回 incomplete、stabilityPassed=false、memoryPassed=null，不把短测标为完整验收。
- 最后采样 RSS 合计 159.625 MiB，系统归属 footprint 合计 81.1198 MiB。两者定义不同，不能推导“省下”了多少内存，也不直接证明某个预算达标。
- [原始报告](memory-sampling-smoke.json)保留构建指纹、环境和样本。产品构建包含尚未提交的前轮候选优化；此证据仅用于验证测量链路。未重跑产品类型检查或构建，本轮未修改产品代码。
