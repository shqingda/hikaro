# 启动性能与升级回退验收 · 2026-10-20

## 性能

CPU 采样及临时分段计时显示：TUI 同步模块初始化推迟 SQLite worker 创建。独立入口提前创建 worker，再并行加载 TUI 与 Runtime；早期 Runtime 失败也关闭已创建的 store。附着入口改为并行连接 host 与加载 UI/workflow，沿用 openInteractive 的失败清理，不提前宣布 ready。

macOS arm64 / Apple M3 Pro / Node v26.12.0。原门槛保持启动 p95 ≤ 200 ms、输入 p95 ≤ 16 ms、客户端 RSS p95 ≤ 100 MiB。每组 3 次预热、30 次测量、每次 20 次输入；空 V8 缓存、预热 OS 缓存、原工作区与用户 Skills 均保留。无其他构建或测试并行运行，未停止用户应用、删除慢样本或更改就绪口径。

| 指标 | 独立 TUI | 附着 TUI |
| --- | ---: | ---: |
| 修复前启动 p95 | 226.56 ms（失败） | 227.61 ms（失败） |
| 最终启动 p95 | 174.58 ms | 188.54 ms |
| 最终输入 p95 | 1.43 ms | 0.99 ms |
| 最终客户端 RSS p95 | 79.30 MiB | 63.89 MiB |

最终两个报告对应同一 bundle graph SHA-256：`9fa3e9491706fc279316aeb95088362f53dd1bb0b1879d4388d62deca0bef2e5`。完整样本与环境见 [standalone-before](release-performance-data/standalone-before.json)、[attached-before](release-performance-data/attached-before.json)、[standalone-final](release-performance-data/standalone-final.json)、[attached-final](release-performance-data/attached-final.json)。候选阶段独立 176.92 ms、附着 188.93 ms 通过，最终报告替代候选结果，未隐藏初始失败。

共享 host RSS p95 72.16 MiB，host+TUI 合计 p95 **135.89 MiB**。客户端门槛通过不代表共享合计内存通过，原合计预算问题仍须解决。当前只是单机离线合成测量，不代表真实 provider、冷磁盘或 30 分钟稳定性。

## 升级与回退

`node scripts/check-upgrade.mjs 3a7bc2b` 通过：实际导出、安装、构建恢复功能加入前的 commit `3a7bc2bbf2c48cf0658d680a0e3bbfd0e1b01e4a`；旧 CLI 离线执行生成数据，关闭写入者后备份完整目录；当前 CLI 读取并继续同一会话，历史事件逐行不变、模型设置和中文草稿保留，新恢复表存在且数据库 integrity_check=ok。复制升级前备份后，旧 CLI 能继续执行，不包含升级后的新写入，草稿及完整性检查通过。

仅验证指定版本路径，不承诺任意旧版本兼容或旧程序直接读取新库。运行中备份、Keychain/设备迁移及真实账号不在本轮范围。

## 其他验证

`tests/performance-interactive-startup.test.ts` 与 `tests/performance-build.test.ts` 共 5 个用例通过：初始化 readiness、失败清理、外部 Zod metadata/校验、Unicode/Markdown/native helper lookup、编译缓存禁用/不可写。`pnpm typecheck`、最终 `pnpm build` 通过。未运行全量测试、额外业务 PTY E2E 或 30 分钟 soak。
