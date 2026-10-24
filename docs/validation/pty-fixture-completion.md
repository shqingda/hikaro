# PTY 模型 fixture 的完成顺序验证

2026-10-23（Asia/Taipei）。一次整合检查中，604 项测试有 603 项通过，`tests/pty.test.ts` 的 continuation compaction 场景在首轮 `fixture-response-1` 等待处超时。失败耗时 8.525 秒，终端持续显示 Working；尚未进入 `/compact`。单独重跑该用例耗时 559 ms，通过；原文件 7 项测试也全部通过。

## 定位与最小修正

fixture 将回复拆成两段，发送间隔为 32 ms。原 `prompt()` 等待完整回复显示后才发送流结束标记。core 的既有增量合并逻辑在消费文本事件时检查距上次输出是否达到 24 ms，并在流结束时输出剩余文本。发送间隔不能保证客户端的消费间隔；两段紧邻消费时，末段可以保持在合并缓冲中。fixture 等待该末段，core 等待下一个事件或流结束，形成循环等待。

修正仅调整完整回复 fixture 的生命周期：先等待 Working 可见，写完回复便结束流，再等待完整回复和 Enter send。两个显示断言、超时值、最终数据库断言均保留。专门测试开放流取消的场景仍由场景自行控制结束，不作修改；产品增量合并逻辑也未修改。

## RED / GREEN 证据

- 强制时序：临时将 fixture 两段间隔从 32 ms 改为 0 ms，只运行 compaction 用例。旧顺序在 `fixture-response-1` 处超时，耗时 8.383 秒，持续 Working，与全量失败的等待点一致。
- 保持同一 0 ms 时序，调整完成顺序后用例通过，耗时 450 ms。没有增加超时或删掉断言。
- 恢复原 32 ms 间隔后，`pnpm exec vitest run tests/pty.test.ts --reporter=verbose` 于 20:12:58 运行，7 项全部通过，耗时 4.42 秒；其中 compaction 为 538 ms，开放流取消为 742 ms。
- 随后 `pnpm typecheck` 通过。最终 diff 仅包含 `prompt()` 的完成顺序和解释注释。

全量失败没有记录每段在客户端的实际消费时间，因此不声称已直接测得当时的调度间隔。强制时序证明原 fixture 存在可重复的循环等待，修正消除了这项依赖。本轮没有重跑全量或性能基准；最终整合检查由主任务统一记录。

## 整合检查

2026-10-24 11:12（Asia/Taipei）在 HEAD `d2611d7` 加本修正上运行 `pnpm check`，退出码 0：113 个应用测试文件、604 项测试全部通过，15 项 Node 脚本检查通过，根类型检查与 CLI 构建通过。日志 `/tmp/hikaro-check-20261024-pty-fixture.log`。单次全量通过不证明时序竞争已在所有负载下消失；上文强制 0 ms 时序的 RED/GREEN 才是本修正的主要证据。
