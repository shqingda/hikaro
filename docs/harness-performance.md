# Harness 与性能

更新：2026-10-18。目标是让 agent 在长任务、取消、权限和恢复边界上可靠，同时用同口径数据约束开销。通过一个合成基准不等于真实模型、终端显示、原生客户端或长期运行全部达标。

## H1 共享 host：2026-10-18 最终复核

最终启动源码基线 `30c4697`，工作区 dirty 仅含文档改动；Node 26.12.0、macOS arm64 / Apple M3 Pro。独立与附着启动报告的完整分发图 SHA-256 均为 `2391942bf01b3f4ed584d35fcb27bfb5f1803c66f1db259e27328a3bf4ac5723`。两项启动门槛顺序运行，没有同时运行构建或测试；以下后续修改只有文档，不改变该构建。

| 口径                                                                                 | 启动 p95  | 输入 p95 | TUI RSS p95                   | host RSS p95 | 合计 RSS p95 |
| ------------------------------------------------------------------------------------ | --------- | -------- | ----------------------------- | ------------ | ------------ |
| 独立 TUI，冷 V8 缓存／新数据目录，30 次 + 3 次预热                                   | 164.67 ms | 1.268 ms | 70.80 MiB（含 SQLite worker） | 同进程       | 70.80 MiB    |
| 已就绪独立 host 的附着 TUI，客户端冷 V8 缓存／每次新 host 数据目录，30 次 + 3 次预热 | 175.03 ms | 1.080 ms | 59.88 MiB                     | 66.25 MiB    | 126.00 MiB   |

原独立 TUI 的 200 ms／16 ms／100 MiB 三项门槛全部通过。附着进程按相同 200 ms／16 ms／100 MiB 预算单独检查；**126.00 MiB 是双进程总开销，超过原单进程 100 MiB，不能用界面进程的通过宣称总内存也满足该门槛**。共享模式保留这项额外成本，后续继续优化；本轮没有提高或替换原基准的预算。

附着计时从 PTY spawn 开始，到 hello、权威快照、初始会话、历史和本地草稿恢复完成后显示 `Attached to shared host.` 为止。host 在计时前就绪，因此不代表冷主机启动。host 内存与 TUI 内存同时在界面就绪处读取，再按每个样本相加计算合计 p95；不会把两个各自 p95 相加冒充合计分位数。所有启动样本仍测 20 次输入。首次 1 次／0 次预热观察报告 `artifacts/benchmark-shared-host-observation.json` 只是采样器排查，host RSS 当时取自主机初始就绪处，不能替代最终的同时取样报告。

最终原始报告：`artifacts/benchmark-shared-host-standalone-delegated-final.json`、`artifacts/benchmark-shared-host-attach-delegated-final.json`。目录按现有规则不入 Git，以上源码版本及命令可用于复现。此前 `0881c95`（`*-final.json`，图 `943409a7…`）和 `c9bc286`（`*-selection-fix.json`，图 `d058beb6…`）的通过报告全部保留；后续控制竞争与委派审批修正改变了分发图，因此最终构建重新测量，不按数值择优。

共享合计 RSS 指 host + TUI，不含可选 `--serve` 桥接、外部工具和其他服务。不能把这项双进程观察外推为完整远程运行的全部内存。

10k core/storage 在源码 `0881c95` 顺序测量，后续两次修正没有改变该基准依赖的 core 执行代码或 storage 实现，因此没有重复运行通过的基准。保持 **10,000 事件 + 10,000 stream chunks**、1 次预热／3 次测量、原正确性断言：append p95 **606.08 ms** ≤1500；replay **19.65 ms** ≤100；message page **0.121 ms** ≤5；context history **2.258 ms** ≤25；stream **4.511 ms** ≤50；event loop **10.052 ms** ≤20；最高 RSS **99.34 MiB** ≤160。全部通过，原始报告 `artifacts/benchmark-shared-host-harness-final.json`。SQLite WAL／FULL 与 native 文件防护未降低。

这些证据不含生产 relay／外部模型、移动真机、耗电或 30 分钟 soak；原生移动性能仍需按路线单独验收。

## TUI / 移动方向调整后的复核

指标只属于现有 TUI 和 core/storage。2026-10-18 本机 Node 26.12.0、macOS arm64 / M3 Pro，最终构建图 SHA-256 `ce18b7f2c605f17c73fe9f7c50c35837680a5e702ce26654ffa603a9cc1257d0`；报告开始采集时基线为 `94fac7b` + dirty shared-client 改动，该源码随后提交为 `e622d85`。

- 最终 TUI 冷 V8 缓存、每次新 data home、当前工作区及用户 Skills 保持开启；30 次测量、3 次预热。启动 p95 **174.02 ms**，输入 p95 **1.765 ms**，就绪 RSS p95 **70.86 MiB**；原 200 ms / 16 ms / 100 MiB 门槛均通过。首个独立启动 180.58 ms。报告：`artifacts/benchmark-tui-mobile-final.json`。
- 10k core/storage：append p95 **641.24 ms**、replay **20.63 ms**、message page **0.128 ms**、context **2.475 ms**、stream **5.091 ms**、event loop **10.641 ms**、最高 RSS **98.54 MiB**。原断言与预算全部保留并通过；3 次测量、1 次预热。报告：`artifacts/benchmark-harness-tui-mobile-direction.json`。
- 保留先前观察：`artifacts/benchmark-tui-mobile-direction.json` 启动 p95 178.12 ms、输入 1.320 ms、RSS 70.80 MiB；它与 harness 驱动有短暂并发，不能用于隔离变量的优化收益比较。之后仅因分发 worker 格式化改变文件字节，重新构建并单独运行最终启动门槛；没有筛掉样本或改低预算。仍未覆盖真机移动端、真实网络、真实 provider 或 30 分钟 soak。

方向及下一阶段门槛见 [TUI 与移动端路线](tui-mobile-direction.md)，协议验证见 [validation](validation.md)。

## 当前可运行的验证

```sh
pnpm install
pnpm build
pnpm bench                  # 3 次预热 + 30 次独立进程启动，各测 20 次输入回显
pnpm bench:check            # 相同工作负载；任何性能门槛失败则返回非零
HIKARO_BENCH_CACHE=warm pnpm bench:check # 单独测共享编译缓存；不可替代默认冷缓存门槛
HIKARO_BENCH_CACHE=disabled pnpm bench # 单独测 Node 缓存关闭时的启动
pnpm bench:attach:check     # 30 次附着 warm host；同时报告 TUI、host 与总 RSS
pnpm bench:harness          # 1 次预热 + 3 次 SQLite/core 工作负载
pnpm bench:harness:check    # 固定工作负载与最小采样数，不允许缩小数据量绕过门槛
```

默认输出 `artifacts/benchmark.json` 和 `artifacts/benchmark-harness.json`，包括原始样本、环境、Git revision/dirty、门槛结果和测量限制。启动报告记录全部运行时 bundle／worker／安全 helper 的 SHA-256 和汇总指纹，避免小 launcher 不变却实际代码不同的对照。输出目录默认被 Git 忽略；可用 `HIKARO_BENCH_OUTPUT`／`HIKARO_HARNESS_OUTPUT` 保存对照报告。

默认 `HIKARO_BENCH_CACHE=cold`：每个独立进程获得新的空 V8 编译缓存目录，仍先做 3 次 OS／文件缓存预热，再测 30 次。`warm` 使用一个隔离缓存目录，`disabled` 显式禁用编译缓存。每种模式还保留一次预热前的 `firstLaunch`，作为空缓存首次运行样本；单一样本不构成 p95，也不声称冷磁盘／重启系统后首次运行。临时缓存不复用或删除用户的 Node 缓存。

临时 home 和数据库在成功或失败后清理；采样数无效、RSS 采样失败、没有就绪画面或流数据不完整都算失败。基准不读取生产凭据、不发真实模型请求。启动仍保留当前工作区和用户 Skill 发现，因此复测应保持相同目录、Skill 配置、Node、硬件和后台负载。

## 工作负载与门槛

| 观察对象            | 固定工作负载                                             | 当前门槛                              |
| ------------------- | -------------------------------------------------------- | ------------------------------------- |
| TUI 启动            | PTY spawn → 首个带 `/help` 的就绪帧                      | p95 ≤ 200 ms，沿用原目标              |
| 输入                | PTY 写入 → 编辑框回显；30 × 20 次                        | p95 ≤ 16 ms                           |
| 就绪内存            | 主进程 RSS，包含 SQLite worker                           | p95 ≤ 100 MiB，沿用原目标             |
| 持久写入            | 10,000 次顺序 append，WAL + synchronous=FULL             | 总耗时 p95 ≤ 1,500 ms                 |
| 事件重放            | 从头分页读完 10,000 个事件，校验顺序和内容               | 总耗时 p95 ≤ 100 ms                   |
| 消息分页            | 50 次、每页 20 条，滚动读取历史                          | p95 ≤ 5 ms                            |
| 上下文历史          | 10,000 事件中的 1,000 条消息                             | p95 ≤ 25 ms                           |
| core 流式输出       | 10,000 chunks / 130,000 字符，每 250 chunks 让出事件循环 | 总耗时 p95 ≤ 50 ms                    |
| core 事件循环／内存 | 上述完整工作负载                                         | delay p95 ≤ 20 ms；采样 RSS ≤ 160 MiB |

后六项是新工作负载的回归上限，并非启动／空闲内存目标的替代。RSS 每 10 ms 及阶段边界采样，不是精确峰值；3 次测量的 p95 实际接近最大值，只适合粗粒度回归信号。20 次输入回显不是物理键盘到屏幕像素延迟，core 流式耗时也不是终端显示延迟。

## 测量与优化记录

环境：macOS arm64，Node 26.12.0，pnpm 12.11.2，同一工作区。以下先保留上一轮基线，完整原始报告和后续优化结果由本轮验收记录列出。

| 改动                 | 改前 → 改后                                              | 结论                                                         |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 模型目录延迟加载 SDK | 30 次启动 p50 291.64 → 229.37 ms；p95 405.24 → 324.81 ms | 保留：配置读取不再加载整套模型 SDK；启动仍未达到 200 ms 门槛 |
| 同一改动的就绪 RSS   | p95 96.70 → 81.39 MiB                                    | 保留，低于 100 MiB 目标                                      |
| 输入回显             | p95 2.43 → 3.26 ms                                       | 均低于 16 ms；不声称输入速度改善                             |

独立 import profile 进一步定位 Runtime 加载从约 109 ms 降到 29 ms，支持收益来自 SDK 延迟加载。最早 7 次未预热、并行负载下的约 727 ms 启动中位数不用于计算收益。OS／进程启动开销、后台任务和缓存影响总耗时，保留 spawn-to-ready 的原测量口径。

严格同源码图、仅切换 eager/lazy 的 8 次交替新进程实验，配置读取 p50 89.66 → 25.19 ms、p95 93.51 → 27.71 ms；该微基准不能替代完整启动耗时。并行 Runtime/TUI import 约 71 → 71 ms，没有收益，未引入改动。

后续对真实进程启动继续剖析：8 次交替的空 Node 进程，pipes wall p50 92.00 ms、PTY wall p50 95.55 ms，而子进程打印时 uptime p50 约 8–9 ms。wall 包含退出，差值只用于定位本机 OS／启动器开销，绝不从产品 spawn-to-ready 门槛扣除。原始报告为 `artifacts/benchmark-spawn-floor.json`。

保留的启动改动：

- 将测到的启动纯 JavaScript 图（Zod、pi-tui 及其 marked／Unicode 宽度依赖）纳入生产 bundle，减少 Node 对大量小模块的查找和解析。可选模型 SDK 和 native addon 继续沿原路径解析。
- 将 15 处 Zod 的嵌套 namespace 导入改为顶层 namespace 导入，保持 API／校验行为；esbuild 可以删除未引用导出，Zod 共享 chunk 从约 740 KiB 降到 200 KiB。外部插件仍可以使用独立安装的 Zod。
- 在独立 launcher 中启用 [Node 原生编译缓存](https://nodejs.org/api/module.html#module-compile-cache)，由 Node 处理版本、失效、禁用和不可写情况。首次运行仍真实编译；应用代码不维护自己的缓存格式。
- Runtime 初始化与 TUI 模块加载并发，等待两者成功后才创建并绑定终端。加载失败会关闭已打开的 Runtime；会话恢复、权限配置、工具、草稿及 UI 初始化仍在首个 ready 帧之前完成。
- SQLite 的初始建表与旧 lease 迁移放入同一个事务，保持 WAL、`synchronous=FULL` 和逐项约束，避免每条 DDL 独立提交；真实失败回滚与旧库双连接迁移均有回归测试。

打包的插件兼容性由 `tests/performance-build.test.ts` 验证：外部 Zod 创建的 schema 在打包后的 ToolRegistry 中保留 metadata、JSON schema、输入校验；TUI Unicode 宽度、Markdown 依赖与 native helper 安装路径有效；编译缓存被禁用或不可写仍能正常启动。`tests/performance-interactive-startup.test.ts` 覆盖并发初始化的 ready 与清理边界。

最后补充的启动优化：缺失的可选 AGENTS.md 先由 realpath 判定，避免为不存在的文件启动安全 reader；已有文件继续走工作区边界检查与 descriptor-safe 读取。会话、权限、历史和草稿准备完成后立即绘制首帧，Git 分支／状态作为原本异步的辅助信息在下一轮事件循环更新。生产 bundle 启用语法和空白压缩，保留标识符与 sourcemap；原插件／Unicode／native lookup 两项定向测试再次通过。三个小模块并行 import 的独立试验无稳定收益，已撤回。

最终生产构建：每次使用空 V8 缓存，保留原工作区和全部用户 Skill 发现，3 次预热 + 30 次独立进程，每次 20 次输入。OS 文件缓存已预热，不等于冷磁盘／开机测量。

| 指标                 | 最终值            | 原门槛结果                        |
| -------------------- | ----------------- | --------------------------------- |
| 启动 p50／p95        | 175.96／181.00 ms | **通过 p95 ≤ 200 ms，命令退出 0** |
| 预热前首次空缓存启动 | 181.92 ms         | 单一样本，不替代 p95              |
| 输入 p95             | 1.37 ms           | 通过 16 ms                        |
| 就绪 RSS p95         | 72.67 MiB         | 通过 100 MiB                      |

最终原始报告为 `artifacts/benchmark-startup-minified-final.json`，已同步到 `artifacts/benchmark.json`；bundle graph SHA-256 为 `65dc9f43e5c05e6c36a2dde9068b2ff9e50599261efcd633a004d949bf0c6905`。完整失败候选保留：早期两组 p95 229.64／550.52 ms，DDL 阶段 219.54 ms，可选说明文件预检查阶段 203.88 ms，首次立即绘制阶段 200.63 ms，独立 import 试验 209.68 ms。200.63 ms 仍被判失败，没有取整放行；最终通过来自后续构建改动，未删除样本或放宽门槛。后台负载会影响尾部，一次固定设备验收不代表所有机器或真实 provider 都达到相同数值。

10k harness（`artifacts/benchmark-harness-final.json`）全部通过：写入 p95 621.07 ms、重放 21.56 ms、分页 0.151 ms、上下文读取 2.542 ms、流输出 5.328 ms、事件循环 delay 10.732 ms、RSS 采样最大 92.39 MiB。最后的改动仅涉及客户端启动读取与打包，核心／SQLite harness 源码未再修改，未重复跑未受影响的测试。真实大历史渲染与 30 分钟稳定性仍另行验收。

上下文 fit 采用固定 16K 窗口、20 次预热、40 次交替测量：10K 消息中位数 23.296 → 14.173 ms，p95 23.936 → 14.605 ms。1K 基本持平，4K 约增加 1.2 ms；保留线性遍历，并明确更完整计量的代价。

上一轮 10k harness 测量：持久写入 p95 607.34 ms、完整重放 20.34 ms、消息分页 p95 0.158 ms、上下文读取 2.387 ms、10k chunk 流输出 5.203 ms、事件循环 delay p95 10.60 ms、RSS 采样最大值 101.82 MiB；上述独立工作负载门槛全部通过。流文本与持久事件逐项核对，不以丢失内容换取速度。

原始报告：`artifacts/benchmark-startup-before.json`、`artifacts/benchmark-startup-after.json`、`artifacts/benchmark-catalog-import.json`、`artifacts/benchmark-harness.json`。demo 就绪内存达标不代表真实 provider 与可选组件全部加载后的内存验收；30 分钟稳定性尚未测量。

## 可靠性覆盖与下一步

现有取消、租约 fencing、文件竞争、授权、RPC scope 和远程撤销回归仍保留。本轮增加：

- `tests/context-budget.test.ts`：完整请求预算、正常默认工具集、超限前拒绝、共享最后一次模型调用竞争、摘要来源和多语言分块。
- `tests/session-search.test.ts`：跨页查找、工作区隔离、Unicode 大小写、字面量特殊字符、旧结果抑制、结果翻页。
- `tests/draft-recovery.test.ts`：持续输入合并、串行清空、会话隔离、写失败与重试、空 flush 的微任务竞争。
- `tests/draft-recovery-pty.test.ts`：真实 CLI 输入 → 自动保存 → SIGKILL → 重启恢复 → 发送清空；一个独立 E2E 场景。
- `tests/performance-harness.test.ts`：采样参数、百分位、缺测失败、清理和缩小后的真实工作负载正确性。

本轮续做已完成事务性自动压缩、文件/图片输入和客户端 C0 首切片，验证记录见 [本轮验收](validation.md#automatic-compaction-attachments-and-client-c0-2026-10-18)。尚待完成：provider tokenizer／图像精确预算、跨重启预算与待发队列恢复；大历史真实渲染、生成中滚动、100／1,000 chunk 不同突发模式、30 分钟有负载稳定性；真实 provider 限流、断网和恢复。恢复草稿不代表自动重放未确定是否执行的命令。

下一阶段：将 TUI 与手机附着到同一 host，补齐安全连接、审批归属和客户端恢复。手机的内存、首屏和触控门槛见 [TUI／移动端路线](tui-mobile-direction.md)。主机相关预算在固定设备复测稳定后再接入 CI 性能 job，当前 PR CI 仍负责正确性回归。

## C0 durable receipts and secure skill batching — 2026-10-18

The existing budgets, timing boundaries and workload remain unchanged. Final cold-V8-cache measurement (`artifacts/benchmark-client-c0-batch-final.json`, also copied to `artifacts/benchmark.json`): three warmups, 30 launches, 20 input samples each, current workspace and 33 user Skills, warm OS caches. Startup p50 **163.29 ms**, p95 **165.54 ms**; first launch before warmups **160.18 ms**; input p95 **1.26 ms**; ready RSS p95 **70.66 MiB**. All original 200 ms / 16 ms / 100 MiB checks pass. Bundle graph SHA-256: `5c1ece42059155960a424fe01bc8dcf19cd42847a38aca2e0d0d3deec93cab70`.

Changes retained:

- CPU sampling identified module compilation/evaluation and helper spawning as startup costs. An in-memory comparison of the same final sources with only identifier minification toggled reduces the bundled JS from 720,030 to 534,782 bytes (maps and separately copied workers excluded in both); ESM exports and source maps remain, and the two existing production packaging compatibility tests pass. Do not attribute all observed latency movement to this flag.
- Skill discovery previously launched one descriptor-safe native helper per file. It now reads each folder in one helper, with the same canonical path checks, per-file 2,000,000-byte limit, complete stable-file/EOF checks, error isolation and cancellation. Buffers are consumed one file at a time; only a bounded decoded description prefix survives. The same 33 resources and final instruction text were compared against the previous commit and are semantically identical. No resource discovery or permission initialization was moved past readiness.
- Batch cancellation exposed an unread-stdout cleanup hang. Closing the pipe before terminating/reaping the helper resolves it; existing read/update security tests remain green. No unsafe filesystem fallback was added.

Failed and reverted measurements are retained:

| Attempt                                                   |        Startup p95 | Decision/evidence                                                                     |
| --------------------------------------------------------- | -----------------: | ------------------------------------------------------------------------------------- |
| C0 before scope-race correction                           |          174.27 ms | Passing interim report, not final code                                                |
| Final receipt code, shared load                           |          207.77 ms | Failure retained; never rounded down                                                  |
| Alternating previous commit / candidate, 30 launches each | 208.89 / 201.27 ms | Both fail; demonstrates shared-host variance, not an exemption                        |
| Identifier minification                                   |          192.38 ms | One passing batch; later 219.79 ms failure also retained                              |
| Start SQLite worker before Runtime module imports         |          218.45 ms | Reverted: median changed about 1 ms, inside noise; no additional abstraction retained |
| Secure batch reads, final code                            |      **165.54 ms** | Retained; full original gate passes                                                   |

Raw files use `artifacts/benchmark-client-c0-*.json`. No user application was stopped, no slow samples discarded, no threshold or measurement boundary changed. These are one-device measurements, not a guarantee under arbitrary OS contention or a native-client result.

The 10k core/storage harness passes with the new receipt schema/run snapshots: append p95 **643.42 ms**, replay **21.53 ms**, page **0.142 ms**, context **2.499 ms**, stream **5.501 ms**, event-loop **10.633 ms**, max RSS **98.68 MiB**. WAL/FULL and every content/order assertion remain. Report: `artifacts/benchmark-harness-c0-before-native.json`, copied to the canonical harness report. Native skill batching does not run in that core/storage fixture, so it was not redundantly repeated afterward. This remains three measured synthetic runs plus one warmup, not a 30-minute soak.
