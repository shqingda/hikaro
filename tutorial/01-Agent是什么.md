# 第 1 章　Agent 是什么：从一次模型调用到一个循环

**本章解决：** 模型只会“说”，为什么 Agent 能读文件、改代码？
**前置：** [interview 16 LLM 基础](../../interview/16_LLM_基础.md) §1（模型在预测下一个 token）；[17 工具调用](../../interview/17_Prompt_结构化输出与工具调用.md) §3。
**实验：** [`labs/01-agent-loop.mjs`](labs/01-agent-loop.mjs)

[总目录](README.md) · 下一章：[和模型通信](02-和模型通信.md)

---

## 1.1 模型只输出文字，动手的是程序

用户说：“把 `greeting.txt` 里的 `Helo` 改成 `Hello`。”

模型能做的，只是输出一段内容。哪怕它输出的是一个很像命令的对象：

```json
{ "name": "edit_file", "arguments": { "path": "greeting.txt", "oldText": "Helo", "newText": "Hello" } }
```

这也**只是一份数据**，文件不会自己改变。真正的修改要靠程序：收到这份数据 → 找到叫 `edit_file` 的工具 → 检查参数和权限 → 执行。

这就是 Agent 的分工：

> **模型提出下一步做什么，宿主程序决定能不能做，并负责真正去做。**

“宿主程序”（host）就是调用模型、执行工具的那个程序，在本课程里是 Hikaro。

## 1.2 一次工具调用不够，所以要循环

模型第一次被请求时，还没看过文件。它只能说：“先读一下 `greeting.txt`。”

程序读到 `Helo, Ada!`。但**程序知道了，不等于模型知道了**。模型没有记忆，每次请求都是从头读输入。所以程序必须把读到的内容放进**下一次**请求，模型才能据此提出修改。

修改完也一样：结果要再告诉模型，它才能决定是检查一下，还是结束。

于是 Agent 就是一个循环：

```text
把用户要求放进历史
重复（有次数上限）：
    把历史发给模型
    保存模型回复
    回复里没有工具调用？ → 结束
    执行每个工具调用，把结果放进历史
```

Agent 并不是什么新程序结构。关键能力只有一个：**程序根据模型返回的结构化请求改变环境，再把环境的反馈交给模型。**

## 1.3 消息历史：一份账本

修复 `greeting.txt` 的完整过程，历史会是这样：

| # | 角色 | 内容 |
| --- | --- | --- |
| 1 | user | 修复 greeting.txt 的拼写 |
| 2 | assistant | 调用 `read_file`，编号 `read-1` |
| 3 | tool | `Helo, Ada!`（对应 `read-1`） |
| 4 | assistant | 调用 `edit_file`，编号 `edit-1` |
| 5 | tool | 修改成功（对应 `edit-1`） |
| 6 | assistant | 已修复。 |

注意三个数字不一样：**用户发了 1 次，模型被请求了 3 次，工具执行了 2 次。**

Hikaro 的消息类型：

```ts
// 源码：packages/core/src/types.ts（删去图片等字段）
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message = {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ToolCall[];   // assistant 消息里：模型要调用的工具
  callId?: string;          // tool 消息里：这是哪次调用的结果
  name?: string;
  isError?: boolean;
  timestamp: number;
};
```

两个要点：

- **工具请求是 assistant 消息的一部分。** 一条 `text: ""` 但带 `toolCalls` 的 assistant 消息不是“模型没说话”，而是它输出了给程序看的请求。
- **`callId` 不能省。** 同一个工具可能一次被调用好几次（比如同时读两个文件），只看工具名分不清哪个结果对应哪个调用。调用里的 `id` 和结果里的 `callId` 一一对应。

## 1.4 工具有两面

模型怎么知道有 `read_file` 这个工具？程序又怎么找到执行代码？一个工具同时包含两部分：

```ts
// 源码：packages/tools/src/index.ts（read_file 定义节选）
name: "read_file",
description: "Read a text file with numbered lines. Use offset and limit for large files.",
schema: z.object({
  path: z.string(),
  offset: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
}),
// 另外还有 execute(args, context)：真正读文件的代码
```

| 部分 | 给谁 | 作用 |
| --- | --- | --- |
| `name`、`description`、参数说明 | 模型 | 知道有什么工具、该怎么填参数 |
| `schema`（校验器）、`execute` | 程序 | 检查参数、真正执行 |

发给模型的只有第一部分。`ToolRegistry.definitions()` 把每个工具的 Zod schema 转成 JSON Schema（一种描述 JSON 结构的通用格式），连同名称、描述一起发出去；`execute` 永远留在本机。

## 1.5 Agent 循环的真实代码

Hikaro 的 `Agent.run()` 去掉流式显示、预算、插话等细节，骨架就是 1.2 那段伪代码：

```ts
// 源码：packages/core/src/index.ts（Agent.run，大幅简化）
for (let turn = 0; turn < (this.options.maxTurns ?? 32); turn++) {
  signal.throwIfAborted();
  const { system, tools, context } = await this.requestContext(user.seq, signal);

  let final: Message | undefined;
  for await (const event of this.options.provider.stream({ system, messages: context.messages, tools, signal })) {
    if (event.type === "done") final = event.message;   // 文字增量另行推给界面
  }
  if (!final) throw Error("Provider ended without a final message");
  await this.message(final);                            // 存进历史

  if (!final.toolCalls?.length) {                       // 没有工具调用：结束
    await this.emit("run.end", { runId, status: "completed", usage: this.usage });
    return;
  }
  for (const call of final.toolCalls) {                 // 逐个执行
    const result = await this.invoke(call.name, call.arguments, signal, call.id);
    await this.message({ role: "tool", text: result.text, callId: call.id, name: call.name, isError: result.isError, timestamp: Date.now() });
  }
}
throw Error("Turn limit reached");
```

对照伪代码读：`maxTurns` 默认 32 是次数上限；`provider.stream` 是“请求模型”（第 2 章）；`invoke` 是“执行工具”（第 4 章）；`this.message` 把消息存进历史（第 6 章）。

`completed` 只表示**循环正常结束**，不表示任务真的做对了。模型可能没跑检查就说“修好了”。

## 1.6 `invoke()`：把模型的请求变成受控执行

模型的请求不可信：工具名可能拼错，参数可能类型不对，路径可能指向不该碰的地方。`invoke()` 是第一道关：

```ts
// 源码：packages/core/src/index.ts（Agent.invoke 开头）
signal.throwIfAborted();
if (nesting > 8) throw Error("Tool nesting limit exceeded");
const tool = this.options.tools.get(name);
if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
const parsed = tool.schema.safeParse(args);
if (!parsed.success)
  return { text: `Invalid arguments: ${parsed.error.message}`, isError: true };
// …构造 ToolContext，然后 tool.execute(parsed.data, context)
```

注意两点：

1. **找不到工具、参数不合法，返回的是 `isError: true` 的结果，而不是抛异常。** 这个错误会作为 tool 消息写回历史，模型看到后可以改正重试。工具层面的失败不必终止整个任务。
2. **执行时用的是 `parsed.data`，不是原始 `args`。** 校验后的数据才可信，而且补上了默认值（如 `offset: 1`）。

参数合法，也不等于操作被允许：`{ "path": "README.md" }` 和 `{ "path": "/Users/me/.ssh/id_rsa" }` 都是合法字符串。权限检查在工具内部和运行时策略里，第 5 章讲。

## 1.7 内部格式和厂商格式要分开

上面的 `Message` 是 Hikaro **自己的**格式，不是哪家模型 API 的格式。发请求前，`provider-pi` 里的 `toPi()` 会把它转成 Pi 模型库的格式，比如 `role: "tool"` 变成 `role: "toolResult"`、`callId` 变成 `toolCallId`（第 2 章细讲）。

这样分开的好处：换一家模型接口，只改适配层；执行循环、工具、存储都不用动。

---

## 练习

运行实验：

```bash
node --test labs/01-agent-loop.mjs
```

实验用一个“剧本模型”（按顺序返回预设回复的假模型）跑完整个 `greeting.txt` 修复流程，不联网。

1. 用户发 1 次请求，模型回复依次为：调用 `read_file` → 同时调用 `read_file` 和 `edit_file` → 纯文字。模型被请求几次？工具执行几次？
2. 模型请求 `edit_file`，参数 `{ path: 123 }`。程序会抛异常终止任务吗？
3. 把实验里 `invoke` 中的 `parsed.data` 改成原始 `args`，哪个测试会失败？为什么？

<details><summary>答案</summary>

1. 模型 3 次，工具 3 次（1 + 2）。
2. 不会。`safeParse` 失败，返回 `isError: true` 的工具结果写回历史，循环继续，模型下一轮可以改正。
3. “默认值”那个测试会失败：原始 `args` 里没有 `limit`，校验后的数据才补上了默认值。

</details>
