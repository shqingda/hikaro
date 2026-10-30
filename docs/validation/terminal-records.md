# 后台终端持久记录 · 2026-10-24

## 结果

后台终端在启动、退出以及停止结果确定时写入新表 `terminal_records`：命令、状态、退出码，以及最后 64,000 字符预览输出（存储模块 `terminal-records.mjs` 已加入构建复制清单）。写入失败不影响终端本身。打开 `/tasks` 的 Background terminals 时，先加载该会话保存的记录，再与实时终端合并，实时记录优先。

host 重启后：已观察到退出的终端显示 `exited · exit N` 和保存的输出；没有退出记录的显示为 `unknown after host restart`，详情注明“Saved by an earlier host. This process was not stopped or verified after restart.”。这些记录都不提供发送或停止操作，也不会被重启或续跑。删除会话时一并清理。

## 验证证据

- `tests/terminal-records.test.ts`（先确认缺少实现时失败）：在 Full Access 的真实 runtime 中启动真实 PTY 命令并等待其退出，存储中出现 `exited`、退出码 0 和输出；另写一条运行中的记录。重新打开 runtime 后，两条记录分别显示为 `exited · exit 0` 和 `unknown after host restart`，均没有操作；停止旧 ID 会被拒绝；删除会话后记录清除。
- `tests/execution-control-pty.test.ts`：列表多了一次存储读取，原用例在菜单项已有“Background terminals”字样时就按 Enter。改为等待列表标题 `Background terminals · page`，产品逻辑未改，连续两次通过。
- `pnpm check` 退出码 0：117 个应用测试文件、617 项测试，15 项脚本检查（含复制后的存储 worker 启动检查），类型检查与构建通过。日志 `/tmp/hikaro-check-20261024-terminal-records.log`。

## 未覆盖

本文对应早期实现；后续 macOS 已观察后代实际探测、历史摘要迁移及重启隔离见 [后代观察](terminal-process-observation.md)。输出只保留尾部预览，不是完整日志。
