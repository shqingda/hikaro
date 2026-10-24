# 当前构建性能与稳定性 · 2026-10-24

后续启动优化及最新状态见 [启动收尾记录](startup-optimization-20261024.md)。本文件保留优化前构建的原始验收结论。

应用源码 `19ae154`，Node 26.12.1、macOS arm64、Apple M3 Pro。本轮修复基准产物指纹遗漏原生进程探针的问题；没有保留应用启动优化。当前启动门槛未通过，不能沿用 10-23 或 10-24 上午旧构建的通过结论。

## 启动与输入

每轮原 30 次测量、3 次预热、每次 20 个输入样本；启动 p95≤200 ms、输入 p95≤16 ms，未修改门槛或删样本。独立临时 home 和空 V8 cache，普通模式为 demo；附着模式先等 host ready，再计客户端启动至历史/草稿恢复及首个就绪帧。

| 轮次               | 模式 | 启动 p95（ms） | 输入 p95（ms） | 启动超过 200 ms | 结果           |
| ------------------ | ---- | -------------: | -------------: | --------------: | -------------- |
| 首轮               | 普通 |        199.277 |          3.232 |            1/30 | 通过但余量很小 |
| 首轮               | 附着 |        270.201 |          1.966 |           17/30 | 启动未通过     |
| 原构建复测         | 附着 |        202.912 |          2.574 |            4/30 | 启动未通过     |
| 指纹修复后最终复核 | 普通 |        263.996 |          3.432 |           10/30 | 启动未通过     |
| 指纹修复后最终复核 | 附着 |        221.608 |          2.893 |           11/30 | 启动未通过     |

原始报告：[首轮普通](performance-20261024/head-19ae154-standalone.json)、[首轮附着](performance-20261024/head-19ae154-attached.json)、[附着复测](performance-20261024/head-19ae154-attached-repeat.json)、[最终普通](performance-20261024/head-19ae154-standalone-final.json)、[最终附着](performance-20261024/head-19ae154-attached-final.json)。

这是共享开发机测量。原用户应用、模拟器与开发服务保留，另有每 20 秒一轮的隔离 soak；最终启动复核时本轮全量测试和短 soak 已结束。负载与空闲内存随环境变化，样本跨度大，不能断言全部超限由产品代码或全部由主机噪声导致。后续应在可重复的负载条件下定位，当前不再循环采样直到变绿。

## 诊断与撤回的试验

- [CPU 采样](performance-20261024/attached-startup.cpuprofile)显示 TUI/Markdown 模块初始化是活跃 CPU 消耗之一；[临时阶段插桩](performance-20261024/startup-stage-diagnostic.json)也显示界面加载后还有连接同步及会话创建。插桩和 CPU 采样改变运行条件，只作定位，不替代门槛。
- 尝试让连接恢复与视图加载并行，临时启动实验 p95 为 201.883 ms，仍未过门槛；相对原构建复测未显示超过噪声的收益。应用改动与实验测试均已撤回。[实验报告](performance-20261024/reverted-parallel-startup.json)只证明当时的启动观测，不是已验收候选。
- 交替冷进程导入 TUI 1.2.0/1.4.0，各 5 次；中位数约 44.406/48.250 ms。该小样本未打包、没有 PTY 或应用恢复，仅能说明直接导入差异不足以解释全部启动波动。[原始数据](performance-20261024/tui-import-diagnostic.json)。未降级依赖或修改上游代码。

## 存储与核心流式

`node --import tsx scripts/bench-harness.mjs --check` 通过：1 次预热、3 次测量，10,000 条事件、10,000 个文本 chunk、每 burst 250 个、50 次消息分页查询。逐条回放顺序、持久结果与实时文本相等断言保留。

| 指标       | p95（ms） | 原上限（ms） |
| ---------- | --------: | -----------: |
| 持久追加   |   739.213 |         1500 |
| 回放       |    24.175 |          100 |
| 消息分页   |     0.135 |            5 |
| 上下文历史 |     2.984 |           25 |
| 核心流式   |     8.148 |           50 |
| 事件循环   |    10.559 |           20 |

该 fixture 的 RSS 诊断峰值 89.058 MiB，未超过其固定回归预算 160 MiB；不能推广为产品总内存预算。此项不测真实 provider、网络到屏幕延迟或移动端。[原始报告](performance-20261024/head-19ae154-harness.json)。

## 指纹修复与验证

`c96b099` 将三处重复指纹代码收敛到 `benchmarkFingerprint`，统一包含全部 `.mjs` 与两个原生 helper。缺少原生 helper 时失败；soak 在分配临时 home 前读取指纹。回归先用原算法复现“进程探针已变更但 SHA 未变”，再修至通过；也验证缺失探针拒绝和 sourcemap 不影响运行指纹。

旧算法摘要 `69cf508abea745a71af3be90124a052db92ebf48f89e1ce5e46ca87ae58d1609`；加入探针后的摘要 `4e059e6ba6b6df8e994554d42766d3463c389c8e059856d0e55b33cc26037b74`。两者覆盖范围不同，不能当作不同产品构建的性能差。原始长测开始时使用旧算法，报告保留不改；[原生补充指纹](performance-20261024/native-fingerprint-supplement.json)单列实际采集时间，不伪称在长测开始前已采集。

三个入口都以真实进程短测确认新指纹：[普通](performance-20261024/fingerprint-standalone-smoke.json)、[附着](performance-20261024/fingerprint-attached-smoke.json)、[soak](performance-20261024/fingerprint-soak-smoke.json)。短 soak 只测约 1.33 分钟，状态为 `incomplete`，host/TUI 退出码均为 0；不得算作 30 分钟通过。

本轮 `pnpm typecheck` 和 `pnpm test` 通过：126 个应用测试文件、652 项应用测试、16 项脚本检查。应用构建在长测前完成，之后冻结 `dist`；普通/附着真实 PTY 回归包含在全量测试中。指纹收集前移后定向回归再次通过。按 code-review-and-quality 核对差异，无门槛放宽、测试跳过或新依赖。

## 长时与多客户端内存

完整功能窗口通过：1 分钟预热后连续测量 **30.0023 分钟**，包含预热共完成 **94 轮任务**、91 个测量样本。每 20 秒经真实 PTY 发送唯一标记，用本地 SSE fixture 核对屏幕响应与 SQLite `run.end=completed`。最大墙钟采样间隔 **20.080 秒**；墙钟和单调时间的 40 秒连续性检查保持。没有重启、强制 GC 或拼接窗口，host/TUI 退出码均为 0，`--check` 返回 0。

[原始长测](performance-20261024/head-19ae154-soak.json)与[统计及指纹核对](performance-20261024/soak-summary.json)。结束时全部原报告文件 SHA 均未变化，原生补充指纹也保持一致。测量结束后再次构建成功，但两份原生 helper 字节变化；其 Mach-O UUID 和带随机临时文件名的 ad-hoc 签名标识不同，JS 文件逐个一致。这次重建摘要为 `535e4b3fd7c3da019582934758d79dd287c432943a2b0cbdc9c5721e848a91f5`，不声称它是本轮已测 SHA。已从冻结的 JS 与原始 helper 保留完整已测构建到本机 `artifacts/performance-measured-19ae154`，逐文件验证与测量结束时指纹一致。期间运行过本轮定向/全量测试、启动诊断和闲置内存矩阵；这不是独占负载测试，也不是真实 provider 验收。

host + 一个 TUI 的系统归属 footprint：起点 **92.199 MiB**，终点 **95.068 MiB**，峰值 **101.598 MiB**。各 5 分钟窗口 p50 为 90.652、87.233、94.189、94.877、98.379、95.411 MiB。末窗口高于首窗口，过程中也有自然回落；未见本工作负载任务超时、崩溃或 OOM，但这些数据不能排除更长时间保留增长。`memoryPassed` 继续为 `null`。

闲置内存基线完成两轮。每组新建 home，预热 30 秒后每 2 秒采样一次，共 30 次；demo、不发送任务。独立 TUI 包含存储 worker；共享模式的 SQLite worker 计入 host。fixture/驱动排除，用户应用和另一组长测保持运行。数值为 macOS 系统归属 footprint 合计，不是精确去重的物理页数。

| 模式            | 第一轮 p50 / p95（MiB） | 第二轮 p50 / p95（MiB） |
| --------------- | ----------------------: | ----------------------: |
| 独立 TUI        |         42.740 / 42.802 |         42.974 / 43.693 |
| host 空闲       |         37.427 / 37.505 |         37.505 / 38.146 |
| host + 一个 TUI |         62.337 / 64.462 |         63.774 / 66.431 |
| host + 两个 TUI |         89.356 / 90.246 |         89.668 / 95.887 |

p50/p95 使用 nearest-rank。全部 240 个样本有效，八组的所有产品进程退出码均为 0，开始/结束构建指纹一致。多客户端组各使用独立 client ID 和空会话；这些是低负载基线，不能用作真实模型、工具执行或多端竞争的内存上限。

[原始数据](performance-20261024/idle-memory-matrix.json)与[复现驱动](performance-20261024/memory-matrix.mjs)。从仓库根目录运行 `caffeinate -i node docs/validation/performance-20261024/memory-matrix.mjs`，输出到 `artifacts/memory-matrix-20261024.json`。驱动是本次诊断工具，不加入默认 CI 或内存硬门槛。

内存按 [现行规范](../specs/shared-memory-soak.md)保留 `memoryPassed: null`；设备绝对预算、Linux 实机、真实模型、多端竞争和更长周期继续待评估。
