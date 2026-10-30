# 计划历史浏览验收 · 2026-10-23

## 结果

普通与附着 TUI 均可从 `/plan history` 浏览本会话保存的历史计划，分页读取原始标题、步骤与验证要求。历史界面不提供执行动作；读取、翻页和关闭不会进入 Plan 模式或启动任务。当前计划的批准仍核对当前 ID，旧版本不能批准。

新增独立不可变快照和有序 UUID 索引，避免把当前计划冒充历史。旧版本只保留了最新计划，界面明确更早历史缺失；现存计划会在下一次状态变更前归档。批准、退出 Plan、重启后仍可读；删除会话同时清理历史文件。存储、迁移与协议约定见 [规格](../specs/plan-history.md)。

## 验证证据

18 项定向测试通过。类型检查、构建、格式检查及差异空白检查通过，没有修改发布百分比。

| 范围                                                                            | 结果                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-history.test.ts`                                                          | 5 项：23 个版本及 20 条分页；批准/退出/重启保留；旧格式迁移；删除清理；迟到刷新不得丢失已提交版本；状态提交失败孤儿不可见；同 UUID 内容冲突不得覆盖 |
| `plan-history-panel.test.ts`                                                    | 2 项：真实共用面板显示历史正文和缺失提示，只有返回操作；取消后迟到列表被丢弃                                                                        |
| `plan-history-rpc.test.ts`                                                      | 1 项：真实独立 host/本机 IPC 与设备 bridge scope；能力发布、view 授权可读不可执行、跨选择拒绝、撤权后拒读、owner 也不能批准旧版                     |
| `plan-history-pty.test.ts`                                                      | 2 项：构建产物普通与附着 TUI；从 `/plan history` 阅读第 23 版完整步骤/验证，进入第二页阅读第 1 版原文；退出后 `active:false` 且无 `run.start`       |
| 既有 `planning.test.ts`、`planning-panel.test.ts`、`attached-workflows.test.ts` | 6 项：只读工具边界、持久化、结构化问答、批准/修改、回执与连接代次等回归                                                                             |
| 既有 `planning-pty.test.ts`、`attached-workflows-pty.test.ts`                   | 2 项：普通及附着原有探索/回答/修改/批准执行和工作流 PTY 回归                                                                                        |

执行命令：

```sh
node node_modules/vitest/vitest.mjs run tests/plan-history.test.ts tests/plan-history-panel.test.ts tests/planning.test.ts tests/planning-panel.test.ts tests/attached-workflows.test.ts
node node_modules/vitest/vitest.mjs run tests/plan-history-rpc.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
node node_modules/vitest/vitest.mjs run tests/plan-history-pty.test.ts
node node_modules/vitest/vitest.mjs run tests/planning-pty.test.ts tests/attached-workflows-pty.test.ts
git diff --check
```

## 失败与修复

两项存储测试在实现前因没有历史 API 失败。加入独立快照、版本索引和旧格式迁移后通过。

RPC 测试首次使用 macOS 临时目录的符号链接路径，触发既有工作区身份校验；改为真实路径。跨未选会话读取先触发选择校验，测试按现有授权顺序分别核对未授权 resume、跨选择读取和 view 权限拒绝，没有修改主机授权规则。

PTY 已读到第 23 版后，最初用菜单不支持的 End 键定位翻页入口而超时。改为上下方向键，并逐屏核对被选中的条目后再按 Enter，普通与附着脚本均通过。保留第 23/1 版正文、分页、退出及未启动执行的全部断言，没有延长超时。

独立审查复现了一个持久化竞态：刷新已读入旧状态但迟到返回时，可覆盖同进程刚成功保存的新版本索引。新增故障时序测试先确认重启后第二版从索引丢失，再用写入代次检查及同会话刷新串行化修复；修复后重启保留全部三版。另以状态文件 rename 失败验证未提交快照不会出现在历史中，以已有 UUID 不同正文验证拒绝覆盖且原文件保持不变。

## 未覆盖范围

新 PTY 使用预置计划和离线主机。原有规划 PTY 继续使用确定性模型 fixture，不是新的真实账号验收。完整索引会随版本数增长，未完成超大历史性能/长期内存验收。逐步骤实际执行进度、物理终端和中文 IME 仍是独立工作。
