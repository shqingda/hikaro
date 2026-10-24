# Hikaro 课程：从模型调用到可靠的 Coding Agent

Hikaro 是一个用 TypeScript 写的本地 Coding Agent（终端界面 + 手机远程查看）。这门课以它的源码为主线，讲清楚一个 Coding Agent 从“调一次模型”到“能可靠地改代码”需要解决的问题。

**读者：** 会 JavaScript / TypeScript、写过一点 Node.js 的前端或全栈开发者。用过 AI 编码工具，想弄懂原理，并能自己写出其中的小模块。

**前置知识：** 每章开头列出了面试复习教程（与本仓库同级的 `interview` 项目）里对应的小节。没把握的概念先去那里打底；本课程只把用到的部分重讲一遍。

## 目录

| 章 | 主题 | 一句话 |
| --- | --- | --- |
| [01](01-Agent是什么.md) | Agent 是什么 | 模型提议，程序执行；循环直到不再调用工具 |
| [02](02-和模型通信.md) | 和模型通信 | 流式响应、SSE 分帧、Provider 适配器 |
| [03](03-执行引擎.md) | 执行引擎 | 排队、插话、取消、预算、会话租约 |
| [04](04-工具系统.md) | 工具系统 | 契约、运行时校验、ToolContext、延迟展示 |
| [05](05-文件与终端.md) | 文件与终端 | 路径越界、修改冲突、原子替换、子进程与停止 |
| [06](06-上下文与持久化.md) | 上下文与持久化 | 裁剪与摘要、SQLite 事务、崩溃后不重放 |
| [07](07-扩展与多Agent.md) | 扩展与多 Agent | 代码检索、LSP、MCP、Skills、子 Agent、任务图 |
| [08](08-客户端远程与可靠性.md) | 客户端、远程与可靠性 | JSONL 协议、重放防护、命令回执、测试 |
| — | [综合练习](综合练习.md) | 独立实现一个模块 + 面试复盘 |

建议按顺序读。后面的章节会反复用到前面的三条规则：

1. **模型的输出是数据，不是命令。** 执行前要校验、授权。
2. **每个 `await` 之后，条件都可能变了。** 关键动作前重新检查。
3. **没有结果记录，不等于没有执行。** 结果不明时先查现场，不自动重放。

## 实验

每章一个实验文件，只用 Node 内置模块，不联网、不需要 API key、不改你的项目文件。需要 Node 26（第 6 章用到 `node:sqlite`）。

```bash
node --test labs/*.mjs
```

单独跑某一章：

```bash
node --test labs/03-runner.mjs
```

实验是教学简化版，突出一个机制，不能替换 Hikaro 代码。第 7 章实验特意照搬了 Hikaro 当前的任务图调度循环，复现一个真实 bug。

## 源码

正文里 `// 源码：路径` 的代码来自本仓库，路径相对仓库根目录。常用入口：

| 内容 | 文件 |
| --- | --- |
| Agent 循环、工具调用、排队、取消 | `packages/core/src/index.ts` |
| 消息与 Provider 类型 | `packages/core/src/types.ts` |
| 上下文裁剪与摘要 | `packages/core/src/context.ts` |
| 任务图 | `packages/core/src/task-graph.ts` |
| Pi 模型适配 | `packages/provider-pi/src/index.ts` |
| 文件、搜索、进程、终端工具 | `packages/tools/src/` |
| 安全文件操作（C） | `packages/tools/native/secure-file.c` |
| 子 Agent、MCP 接入、运行时 | `packages/runtime/src/index.ts`、`packages/tools/src/mcp.ts` |
| SQLite 存储 | `packages/storage/src/worker.mjs` |
| RPC 协议 | `packages/protocol/src/index.ts` |
| 加密通道 / 远程宿主 | `packages/crypto/src/index.ts`、`packages/remote/src/host.ts` |

本课程对照 Hikaro 提交 `625f920`（2026-10-24）。
