# 未提交问题答案草稿验收

日期：2026-10-23。对应 [规格](../specs/question-answer-drafts.md)。本片补齐普通与附着 TUI 结构化问答的已选答案、未按回车自由输入及当前位置恢复；不扩展到任意临时面板或秘密输入。

恢复仍需用户核对并显式提交。恢复本身不调用模型、不解除 Plan、不继续旧工具等待，也不派发待发消息。草稿按问题组 UUID、审批归属会话和原 scope 隔离；保存使用事务内 CAS，提交再次核对草稿版本，答案结算与草稿删除在同一事务完成。

## RED → GREEN 证据

下列为本轮实际执行记录。真实 PTY 两项由独立验收代理执行；后端、面板、退出与构建检查由各实施代理执行并回报。独立审查未重复全量运行。

| 检查                   | 实际 RED                                                                                                                                                    | 修复后证据                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 草稿存储与服务         | `tests/question-drafts.test.ts` 首批 7 项全部失败：`readDraft` / `saveQuestionDraft` 尚不存在，capability 未包含草稿方法                                    | 首批 7 项通过；补充生命周期、真实 RPC 和事务回滚后 10 项通过                                                                                      |
| 未回车输入回调         | `tests/planning-panel.test.ts` 新用例没有收到 `onChange`                                                                                                    | 显式启用的普通输入逐次报告原文；提交时内部清空不当作编辑，secret 与未启用的输入不报告                                                             |
| 普通、附着实际 PTY     | 两个进程场景均已进入未提交输入面板，但读取持久结果报 `store.questionDraft is not a function`；2 项失败，10.52 秒                                            | 同一组验收 2 项通过，31.78 秒；详见下节                                                                                                           |
| 附着旧面板迟到提交     | 同一个问题从 live 变为 recovered，旧提交等待 `beforeSend` 后仍发送了 `{ answers: { q: "A" }, id: "same-question", sessionId: "session" }`，预期发送列表为空 | 请求前、真正发送前及返回后检查原面板 signal；整份 `attached-workflows.test.ts` 6 项通过                                                           |
| 正常退出时旧保存仍在途 | 真实 SQLite 配合延迟旧写入：退出后仅有旧文本、revision 1，最新输入丢失                                                                                      | 先冻结 saver，旧保存后继续保存最后文本；得到 `older plus latest 中文🌅`、revision 2，问题仍 pending，无 `question.response`；local 文件 12 项通过 |
| 构建遗漏 worker 依赖   | 仍只复制原有 3 个文件时，隔离目录中的 worker 启动报 `ERR_MODULE_NOT_FOUND`，缺少 `question-drafts.mjs`                                                      | 构建清单补齐第 4 个文件，隔离 worker 草稿读写用例通过；实际构建与包内检查见后文                                                                   |

面板验收期间另有两次测试夹具误判：光标 APC marker 被当作可见输入，以及尚未等到实际题目标题便操作。测试改为过滤可见文本、等待真实标题；未修改功能来迁就这两次失败，不将其计作产品缺陷。

## 实际终端恢复

命令：

```sh
pnpm exec vitest run tests/local-question-recovery-pty.test.ts tests/question-recovery-pty.test.ts
```

结果：2 文件、2 项通过，31.78 秒。使用本机 `node-pty` 启动实际 CLI、隔离 home 与真实 SQLite，本地 SSE fixture 触发两题 `ask_user`。第一题为 `Choose recovery scope`，选择 `Small`；第二题为 `Describe the recovery boundary`，输入精确原文 `待确认  draft 🌅 42`，两个空格保留，未按回车。

两条路径均先确认 SQLite 已保存第一题选项、第二题原文和 `input/detail` 位置，原问题完整且尚无 `question.response`，随后强制终止：

- 普通 TUI：SIGKILL 终端进程，重启同一 home 与会话，显式打开 `/questions`。
- 附着 TUI：问题由实际附着终端发起；SIGKILL 终端和 host，再以相同客户端身份启动 host 与终端。

恢复直接显示 `Your answer` 和完整未提交原文。按回车进入汇总后，两道原题、`Small` 和自由输入均可见。恢复前后读取实际 Planning 状态确认 active 保持为 true，界面保持 Plan read-only；模型请求数仍为 1。

普通路径立即提交被尚未到期的真实执行租约拒绝，原答案与草稿仍保留；等待约 30 秒租约自然到期后显式重试。附着路径同样等待真实租约到期。没有改写租约或伪造到期。

成功提交后，两条路径均只有一条 `question.response` 和一条恢复答案上下文；再次读取草稿因问题已结算而拒绝，并用只读 SQLite 查询确认 `question_drafts` 行数为 0。模型请求数仍为 1，直到用户另发明确提示才增为 2，后续请求包含原答案。普通路径另保留再次问答后 SIGTERM 正常退出的检查：问题仍 pending，没有误取消。

## 定向回归与独立审查

- 后端命令 `pnpm exec vitest run tests/question-drafts.test.ts tests/question-cancellation-recovery.test.ts tests/question-recovery.test.ts tests/rpc-control.test.ts tests/rpc-receipts.test.ts tests/rpc-handshake.test.ts`：6 文件、45 项通过。覆盖真实多连接 CAS、scope/session/workspace/control 权限、活跃租约下保存、恢复结算租约、迟到保存拒绝、取消/删除清理、故障事务回滚、关闭与延迟读取，以及普通 RPC 队列阻塞时仍可读写草稿且不产生 `rpc_commands` 回执。
- UI/退出命令 `pnpm exec vitest run tests/local-question-recovery.test.ts tests/planning-panel.test.ts tests/question-draft-saver.test.ts`：3 文件、20 项通过，分别为 12、5、3 项。覆盖恢复位置与原文、返回修改、显式汇总提交、冲突不提交、300 ms 持续输入保存、版本串行、失败不循环重试、窗口失效丢弃 pending，以及两种正常退出排空场景。
- `pnpm exec vitest run tests/attached-workflows.test.ts`：1 文件、6 项通过，包含同 ID 恢复状态变化后旧面板不再发送答案。
- 实施代理运行的根 `pnpm typecheck` 与改动格式/差异检查通过；PTY 两文件差异检查由独立验收代理确认。

独立只读审查确认：RPC 草稿保存免动作回执和重放，与非只读权限检查分开；worker 在事务中重验 pending 身份与 CAS，恢复结算仍检查租约。回答、取消、草稿清理和事件写入原子完成，迟到保存不能重建已结算草稿。

正常退出修复经过再次独立审查：`finish()` 同步冻结编辑，期间 `stop()` 不清除最终 pending；仅关闭时已打开的 saver 进入 `closingWriters`，固定原问题、session 与 `standalone:tui` scope。问题服务与旧 waiter 仍同步关闭，agent 取消未延后；SQLite 关闭前先等待这些冻结写入，再等待服务已接收写入。保存失败会输出退出错误，不宣称一定落盘。附着面板的原 signal 覆盖读取、保存、提交及 `beforeSend` 等待。

## 构建与包内 worker

新增 `scripts/build-storage.mjs` 将 `worker.mjs`、`pending-steering.mjs`、`statement-cache.mjs`、`question-drafts.mjs` 放在同一输出目录。源文件路径锚定脚本位置；发布清单包含整个 `dist`，包内相对导入路径不变。

`node --test scripts/build-storage.test.mjs scripts/package-release.test.mjs`：2 项通过。前者在独立临时目录启动复制后的 worker，创建问题、保存含中文/emoji 的未提交草稿，再读取同一 revision 和原文；不依赖源码目录补足相对导入。

实施代理另执行 `pnpm build`，确认 `dist` 四个模块与源码逐字一致，并通过真实 `dist` worker 的 `createSession`、`saveQuestion`、`saveQuestionDraft`、`questionDraft`、`close` 调用。随后将完整 `dist` 复制到临时 staging，以 `releaseManifest` 生成当前 macOS arm64 的包清单，用 `npm pack --json --ignore-scripts` 得到 172 文件的临时包，解包后对包内 worker 重做同一草稿写读，通过后清理临时目录。

这是本轮工作区产物的构建和包内路径检查；未安装生产依赖，未运行完整 `packageRelease`、`auditArtifact`、`check:install` 或 `check:release`，未发布 npm 包或安装到用户环境。

## 全量验证

主任务执行最终 `pnpm check` 成功：106 个应用测试文件、548 项应用测试及 15 项脚本检查通过，根类型检查与 CLI 构建通过。应用测试于 18:35:24 开始，耗时 32.26 秒。日志：`/tmp/hikaro-check-20261023-answer-drafts.log`。此轮包含正常退出和附着发送前检查修复，与上面的分阶段定向结果分开记录，不相加为不同测试数量。

## 边界

补充：提交 `f4c52a8` 的 `pnpm check:install` 已通过。隔离目录从已跟踪源码重新安装锁定依赖，类型检查、原生 helper/CLI 构建、实际构建 TUI 启动及正常退出均成功，日志 `/tmp/hikaro-install-20261023-answer-drafts.log`。没有安装到用户全局环境，也不替代新分发 tarball 的升级回退验收。当前源码的 [启动与输入复测](tui-performance-20261023.md)也满足原门槛。

- 强制终止、断线或面板失效前最后约 300 ms，以及尚未完成或失败的写入，仍可能丢失；正常退出会尝试排空冻结后的最后输入，不承诺断电零丢失。
- 真实 PTY 验证的是实际 CLI/host/SQLite 与程序化按键输入；模型为本地 SSE fixture，不是外部真实模型，也不是物理终端输入法验收。
- 旧 host 没有草稿 capability 时沿用原问答功能，不承诺持久恢复；旧客户端不传 `draftRevision` 的兼容路径仍保留。
- 不跨身份接管，不自动恢复旧运行；未另做子代理崩溃 PTY。秘密输入和未显式启用的临时输入不参加草稿回调。
