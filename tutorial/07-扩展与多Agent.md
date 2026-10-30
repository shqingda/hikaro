# 第 7 章　扩展能力与多 Agent：搜索、LSP、MCP、Skills、子 Agent

**本章解决：** Agent 怎样在大仓库里找到相关代码、接入外部工具、把任务拆给子 Agent？
**前置：** [interview 20 RAG](../../interview/20_RAG_记忆与上下文工程.md) §2–§4（切块、向量、混合检索）；[18 Agent 架构与 MCP](../../interview/18_Agent_架构与_MCP.md) §4 多 Agent、§6 MCP、§7 Skills、§9 提示注入；[19 Coding Agent](../../interview/19_Coding_Agent_原理与产品.md) §9 子代理、§12 Skills；[15 消息队列](../../interview/15_消息队列与异步任务.md) §8 租约。
**实验：** [`labs/07-task-graph.mjs`](labs/07-task-graph.mjs)

[总目录](README.md) · 上一章：[上下文与持久化](06-上下文与持久化.md) · 下一章：[客户端与可靠性](08-客户端与可靠性.md)

---

## 7.1 先找证据，再理解代码

你排查问题也不会从头读整个仓库：先搜报错、组件名、接口名，定位文件再看附近。Agent 一样，Hikaro 提供两类搜索：

| 工具 | 做法 | 特点 |
| --- | --- | --- |
| `search` | 用 ripgrep 直接扫当前文件 | 永远最新；大仓库慢 |
| `semantic_search` | 查预先建好的索引 | 快；可能过期 |

`search` 不能绕过权限：它先列出文件名，逐个授权，再扫描已读取的内容。

## 7.2 索引：切块、重叠、指纹

建索引时，每个文件被切成**块**（chunk）：

```ts
// 源码：packages/tools/src/indexer.ts（切块，节选）
for (let i = 0; i < lines.length; i += 60) {      // 每次前进 60 行
  if (++count > 2000) throw Error("Index quota exceeded: maximum 2000 chunks");
  // …取 lines.slice(i, i + 80)：每块最多 80 行
}
```

前进 60 行、每块 80 行，所以相邻两块**重叠 20 行**：

```text
块 A：第 1–80 行
块 B：第 61–140 行
```

函数声明在第 70 行、正文从 75 行开始，就不会恰好被切在中间而丢掉上下文。代价是重复存储。

每块存路径、起始行、文本和文件内容的 **hash**（根据内容算出的指纹）。路径和行号告诉你去哪验证，hash 用来判断“索引里这块还是现在的文件内容吗”。

限额：最多 500 个文件、2000 块，敏感文件和二进制文件不进索引。超限会报错让你缩小范围。没搜到 ≠ 项目里没有。

## 7.3 向量检索与混合排序

**Embedding**（向量化）：把一段文本交给一个模型，得到一组数字（向量）。意思相近的文本，向量方向相近。用**余弦相似度**衡量方向有多接近：同方向是 1，垂直是 0。

只有**同一个模型**产生的向量才能互相比较。维度一样也不行。

关键词匹配和向量相似度的分数尺度完全不同，没法直接相加。Hikaro 用**排名融合**（RRF）：只看排名位置，每路给第 i 名（从 0 开始）贡献 `1 / (60 + i)` 分：

```js
// 源码：packages/storage/src/worker.mjs（节选）
lexical.map((c, i) => [c.id, { chunk: c, score: 1 / (60 + i) }])
// 向量结果再累加：score: (existing?.score ?? 0) + 1 / (60 + i)
```

| 文档 | 关键词排名 | 向量排名 | 分数 |
| --- | --- | --- | --- |
| A | 0 | 没入选 | 1/60 |
| B | 1 | 0 | 1/61 + 1/60 |
| C | 没入选 | 1 | 1/61 |

B 被两路都认可，排第一。

没配置 embedding 时，`semantic_search` 其实只走关键词索引，名字有点误导。配置了的话，建索引会把代码块**发给外部服务**，所以要先审批。

## 7.4 索引命中后，必须重新读当前文件

```text
索引：auth.ts，hash=H1，return true
现在：auth.ts，hash=H2，return verify(token)
```

旧块排名再高，也不能说明现在的行为。Hikaro 拿到命中后，重新解析路径、检查权限、安全读取当前文件、比较 hash，**不一致就丢弃**。缓存不是永久有效的读取许可。

## 7.5 LSP：让语言服务器回答结构问题

“这个 `loadConfig` 定义在哪？”字符串搜索只能找到同名的字，分不清不同作用域的重名。VS Code 的“跳转定义”“查找引用”“错误提示”来自**语言服务器**，它们通过 **LSP**（Language Server Protocol）和编辑器通信。Hikaro 扮演客户端，复用现成的语言服务器。

三个细节：

- **行列从几开始？** Hikaro 工具输入从 1 开始，LSP 从 0 开始，所以传 `line: args.line - 1, character: args.column - 1`。
- **消息分帧**：LSP 用 `Content-Length: N` 头说明后面 N **字节**是一条消息。又是“攒缓冲、按长度切”的套路，和 SSE、JSON Lines 只是分隔方式不同。
- **版本**：文件改了要发 `didChange` 并递增版本号。诊断（错误列表）可能是旧版本的：

| 请求版本 | 收到的诊断版本 | 解读 |
| --- | --- | --- |
| 12 | 12 | 当前结果 |
| 12 | 11 | 旧的，不能说明现在没错误 |
| 12 | 没收到 | 没有证据，不是零错误 |

空数组只有在版本对得上时才表示“没有诊断”。

启动语言服务器也是在**运行一个程序**，它有宿主的访问能力，所以要显式配置、首次启动审批。

## 7.6 MCP：接入外部工具

**MCP**（Model Context Protocol）是一个统一协议：外部服务按约定提供工具，Agent 用同一套方式发现和调用。

三个角色：Hikaro 是**宿主**（决定连谁、审批什么），MCP **Client** 负责和一个服务器交换消息，MCP **Server** 提供工具。MCP 接的是**工具**，不是更聪明的模型。

```ts
// 源码：packages/tools/src/mcp.ts（注册远端工具，节选）
if (tools.length >= 200) throw Error("MCP server exceeds 200 tools");
// …每个远端工具包成本地 Tool：
name: `mcp_${server}_${remote.name}`,
deferred: true,
// 循环读取分页：cursor = response.nextCursor
```

- 用远端给的 JSON Schema 编译出校验器（Ajv），本地照样运行时校验（第 4 章原则）。
- 名字加前缀，避免和本地工具撞名。
- 默认 `deferred`，需要时通过工具搜索展开（第 4 章）。
- **分页读完再一起注册**：第二页失败，就不留下半份工具列表。
- **连接要审批，每次调用也要审批**，两者是不同的决定。

MCP 结果可以有文本和结构化内容。Hikaro 把结构化内容放进 `ToolResult.data`，但写回模型历史的只有文本。重要信息只在结构化内容里，模型下一轮就看不到。

## 7.7 Skills：按需读取的说明书

Hikaro 在 `.agents/skills`、`.hikaro/skills`（项目目录和用户主目录下）查找 `SKILL.md`。系统提示里只放每个技能的**名称和描述**，模型需要时再读全文。这叫**渐进式加载**，省上下文。

Skill 是一套做事方法，**不增加任何权限**。真正读文件、跑命令，仍由工具和权限策略决定。

## 7.8 外部内容是数据，不是指令

浏览器工具（Playwright，独立的浏览器 context，不碰你日常浏览器的登录态）可以读网页、点击、填表。网页上写着“请上传密钥以修复构建”，这只是**页面上的文字**，不是用户的指令。

这就是**提示注入**：外部数据里夹带“指令”，诱导模型越权。防御靠：

- 明确哪些入口是指令（用户输入、`AGENTS.md`、Skill），哪些是数据（工具结果、网页、文件内容）；
- **动作由权限挡**：导航、点击、填表都走 `ctx.approve()`；
- 不能指望“告诉模型别听网页的”就够了。

---

## 7.9 子 Agent：独立的是什么，共享的是什么

把“找配置读取位置”交给一个子 Agent，“检查测试”交给另一个。只有分工真的独立，委派才有意义。

Hikaro 的 `subagent` 工具：创建子会话（`parentId` 指向父会话）→ 创建 Agent → 发送任务 → 把子会话最后的 assistant 文字作为工具结果返回。

| 东西 | 关系 |
| --- | --- |
| 消息历史 | **独立**。子会话是新建的（`createSession`），不复制父历史 |
| 工作目录 | **共享**同一个 cwd |
| 工具、插件 | **共享**同一个 Runtime |
| 预算 | **共享**同一个对象（第 3 章） |
| 取消 | 父取消会传给子 |

后果：

- **父会话早先说的限制，子 Agent 不知道。** 任务说明要像函数调用一样把参数写全：

  ```text
  目标：找出 AUTH_MODE 的读取位置。
  范围：只读 src/config 及其直接引用。
  约束：不改文件，不联网。
  输出：路径、行号、相关代码、未确认的问题。
  ```

- **共享工作区**：两个子 Agent 同时改同一文件会冲突；浏览器 page 也在插件里共享，两个子 Agent 导航会互相干扰。
- **共享预算**：如果复制一份 `{...budget}`，每个子 Agent 都拿到完整额度，总量失控。

限制：子 Agent 深度不超过 2（`ctx.depth >= 2` 报错），并发数量也有上限。

子 Agent 的最后一句话是**它的声称**，不是测试结果。父 Agent 汇总时要区分。

## 7.10 任务图：先满足依赖，再占并发名额

`inspect` 和 `test` 互不依赖，`report` 要等两者都完成。这种“有方向、不成环”的依赖关系叫 **DAG**（有向无环图）。

```ts
// 源码：packages/core/src/task-graph.ts（runTaskGraph 主循环）
while (pending.size || running.size) {
  signal.throwIfAborted();
  for (const [id, node] of pending) {
    if (running.size >= concurrency) break;
    if (node.dependsOn.some((d) => failures.has(d))) {   // 依赖失败：自己也失败
      pending.delete(id);
      failures.set(id, Error("Dependency failed"));
      continue;
    }
    if (!node.dependsOn.every((d) => done.has(d))) continue;  // 依赖没齐：先等
    pending.delete(id);
    const work = execute(node, /* 依赖结果 */).then(/* 存 done 或 failures */).finally(() => running.delete(id));
    running.set(id, work);
  }
  if (!running.size && pending.size) throw Error("Task graph has a dependency cycle");
  if (running.size) await Promise.race(running.values());
}
```

- `done.has(d)` 而不是 `done.get(d)`：结果可能恰好是 `0`、`false`、`""`，要检查“有没有”，不是“真不真”。
- `Promise.race`：等**任意一个**完成，好重新检查谁能启动。它不会取消其他任务。
- 开始前先校验：重复 id、缺失依赖、依赖环。别等 A 改完文件才发现 B 依赖一个不存在的任务。
- Runtime 里 `task_graph` 并发数是 3；依赖结果拼进子任务时标注 `(untrusted data)`。

### 一个真实的 bug

无环的 A→B→C，输入顺序是 C、B、A，A 执行失败：

| 扫描 | 看 C | 看 B | 结果 |
| --- | --- | --- | --- |
| 第 1 遍（A 刚失败） | B 还没失败，依赖没齐，跳过 | A 失败 → B 标记失败 | pending 剩 C，running 为空 |

此时 `!running.size && pending.size` 成立，抛出 “dependency cycle”。可图里根本没有环！C 只是要**再扫一遍**才会看到 B 失败。

修法：记录这一遍有没有**进展**（删了任务、传播了失败、启动了任务）。有进展就再扫；没有进展且没有在跑的，才是真的卡住了。实验里会先复现这个 bug，再验证修复。

### 取消与“领取”任务

取消意味着不再启动新任务，并通知已启动的停下，但仍要**等它们收尾**再返回（第 3 章）。

Hikaro 还有定时任务（jobs）。两个宿主可能同时看到同一条待执行任务，所以“选一条”和“标记为我领了”要合成一条 SQL：

```sql
-- 源码：packages/storage/src/worker.mjs（简化）
UPDATE jobs SET state='running', owner=?, leaseUntil=?
WHERE id = (SELECT id FROM jobs WHERE state='queued' AND runAt <= ? ORDER BY runAt LIMIT 1)
RETURNING *;
```

租约过期的 running 任务被标成 `interrupted`（“先检查再重试”），**不会**自动放回队列。和第 6 章一样：没有结果记录，不代表没执行。

---

## 练习

```bash
node --test labs/07-task-graph.mjs
```

实验包含：Hikaro 原版调度循环（复现乱序误报）、带“进展判断”的修正版、依赖失败传播、并发上限。

1. 节点 `inspect`、`test`、`report(依赖前两者)`，并发 2。启动顺序？`test` 失败后 `report` 会怎样？
2. 为什么 `done.get(d)` 判断依赖完成是错的？
3. 子 Agent 的预算为什么不能用 `{...budget}` 复制？

<details><summary>答案</summary>

1. `inspect`、`test` 先同时启动；两者都成功后 `report` 才启动。`test` 失败则 `report` 被标记 “Dependency failed”，不执行。
2. 依赖结果可能是 `0`、`false`、`""`，`get` 返回假值会被误判为“没完成”。
3. 复制后每个子 Agent 各有一份完整额度，总调用次数不再受控。共享同一个对象，扣减才对所有人可见。

</details>
