# 内存与长时稳定性验收（2026-10-21 修订）

本次由用户明确要求纠正内存验收口径。撤销 RSS 合计 ≤100 MiB 的 release 阻塞条件，不将旧失败自动改成内存通过。

## 来源与适用范围

100 MiB 最早出现在 `26905a550201c7ad38f43c8211efebbbfa9aff5b`（2026-10-13）的 TODO.md，文字为“空闲总 RSS ≤100MiB，含存储 worker 与一个 provider”，当时针对独立 TUI。仓库未记录设备预算、用户约束或实验推导；提交作者身份不能证明谁提出了数值。此前将其扩展为两个进程 RSS 相加的硬门槛没有充分依据，此扩展撤销。独立进程的旧 100 MiB 也保留为历史参考，不再作为未经论证的发布硬门槛。

## 内存测量口径

- 保留每进程 RSS、RSS 之和、p95、峰值和增长曲线，全部标为诊断。RSS 之和会重复计算共享映射，不称为产品实际新增物理内存。
- macOS 使用系统 memory footprint（可经 proc_pid_rusage 读取），分别记录 host、TUI 及产品子进程。它是系统归属的内存成本，不能称为精确去重的物理页总量；有共享可写映射时需核对归属。SQLite worker 已在 host 内，不再相加。
- Linux 使用 smaps_rollup 的 PSS，按共享页映射者比例分摊；记录 SwapPss，避免把换出当成优化。PSS 与 macOS footprint 不混用阈值。
- 分开测独立 TUI、host 空闲、host + 一个客户端、增加第二客户端的成本，以及持续工作负载。产品启动的工具/子进程单列，测试驱动和 fixture 排除；不能隐藏真实产品子进程开销。
- 报告必须含平台、Node 版本、构建指纹、进程集合、采样方法与原始样本。取样失败标为不可用，不回退到 RSS 冒充 footprint/PSS。

## 发布决策

不另拍一个 150/200 MiB 上限。先在相同构建条件和工作负载下测量基线与候选，重复运行确认噪声；依据支持设备的可用预算、典型并发数及实际内存压力确定绝对预算，记录理由后再启用硬门槛。当前平台采集已实现，完整基线与预算校准待完成，内存状态是“待评估”，不是通过或因 RSS 合计超限而失败。

30 分钟功能稳定性独立验收：预热 1 分钟后连续运行至少 30 分钟，每 20 秒经真实 PTY 发送唯一任务，使用本地确定性 SSE fixture，核对输出与 SQLite run.end=completed，最后两个进程正常退出。不重启、不强制 GC、不拼接中断窗口。短测不能通过。此频率受会话 128 次模型调用预算约束，含摘要在内需留余量。

内存长期稳定性另记录全程 footprint/PSS、工作量、初末窗口分布与趋势；区分启动/JIT/缓存扩容和持续保留增长。旧“单个预热点到任意峰值增长 ≤10%”不能单独证明泄漏或作为 release 否决。明确泄漏、OOM、内存压力导致功能退化仍是发布阻塞；持续增长需延长测量、定位保留对象后判断，不能以 GC 后暂时下降宣称通过。

当前 bench:check / bench:attach:check 只判断时间门槛；bench:soak:check 只判断完整功能窗口及正常退出。其报告必须标明 scope，不能被当作整个 release 或内存验收通过。脚本已接入 macOS proc_pid_rusage footprint 与 Linux smaps_rollup PSS/SwapPss；Linux 目前仅解析单测，未做 Linux 实机验收。不得从旧 RSS 反推 footprint。每个采样点保存墙钟时间，任一相邻样本的墙钟或单调时间间隔超过 40 秒即失败（20 秒目标周期加 20 秒容差）；休眠、时钟倒退和长时调度间断不能算作连续窗口。

## 官方依据

- [Apple：memory footprint 与 proc_pid_rusage](https://developer.apple.com/videos/play/wwdc2022/10106/)
- [Apple：dirty 与 compressed memory](https://developer.apple.com/videos/play/wwdc2021/10180/)
- [Linux kernel：RSS、PSS 与 SwapPss](https://www.kernel.org/doc/html/v5.15/filesystems/proc.html)

这些资料支持测量口径，不提供 Hikaro 的 100 MiB 或 10% 发布门槛。
