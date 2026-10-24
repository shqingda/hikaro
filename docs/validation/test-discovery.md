# 应用与脚本测试入口 · 2026-10-23

全量验收发现原 `pnpm test` 的 Vitest 默认扫描还会收集 `scripts/*.test.mjs`（使用 node:test）及旧真实模型验收生成的 `artifacts/**/sum.test.cjs`。这些文件并非 Vitest 测试，产生 15 个 “No test suite found” 失败；另有一个附着 TUI 长输出真实失败，独立修复，未通过排除掩盖。

新增 `vitest.config.ts` 将应用测试发现限定为项目统一目录 `tests/**/*.test.ts`。`pnpm test` 在应用测试后执行 `pnpm test:scripts`，使用 Node 自带测试运行器运行全部六个脚本测试文件。Linux CI 同样增加脚本测试步骤；macOS 的 `pnpm check` 继承完整入口。

本轮发现列表含 94 个应用测试文件；六个脚本文件共 14 项检查全部通过、零跳过。旧验收 workspace 的测试仍由原验收脚本在指定目录运行，不加入应用回归，也不删除历史证据。应用全量最终结果见本轮完成度审计记录。

随后全量暴露 `attached-workflows` 的既有等待竞态：`plan.execute` 接受命令后、`run.start` 到达前，旧 idle 快照可使等待提前结束，导致第二次执行在前一次仍运行时被拒绝。测试现先核对首次操作的持久 completed 回执，再断言旧计划不可执行；保留原错误匹配、单次运行及幂等断言，没有增加超时。三项定向用例通过。
