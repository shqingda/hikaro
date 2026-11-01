# 发布准备

2026-11-01 状态。范围仍是个人自用：不公开发布，不用整体百分比表示进度。逐项缺口以 [TODO](../TODO.md) 为准；10-26 及以前的百分比、轮次和候选证据见[历史记录](history/release-readiness-through-20261026.md)。

## 当前候选

- 已发布：0.3.0（2026-10-26），macOS arm64，自带 Node 26.12.1。
- main 上 11-01 的整理提交尚未打包：命令注册表、steer 语义、跨项目会话、图片 chip、滚动提示和测试整理。新候选需要重新走下方门槛，旧包证据不能代替。
- 性能：启动 p95 约 184 ms（附着约 188 ms），输入 p95 < 2 ms，流式输出在 33 ms 预算内，与冻结基线对照没有退化。200 ms 启动是参考值，不是门槛。

## 门槛

1. 同一 SHA 的候选完成安装、升级、回退，以及一次真实账号闭环（R1：`pnpm check:install`、`pnpm check:upgrade`、`pnpm check:live-release`）。
2. 真实长任务的摘要质量和扩展失败恢复（F6：`pnpm check:live`）。
3. 在真实终端里检查中文输入法候选窗、鼠标选择复制和不同终端主题（`pnpm check:ime`），需要用户操作。
4. 发布前本地运行 `pnpm ci:check`。GitHub Actions 只在明确决定发版时运行。
