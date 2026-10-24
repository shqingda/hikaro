# Bug：任务图在依赖失败时误报依赖环

状态：**未修复**。记录于 2026-10-25，复现基于 `625f920`（`packages/core/src/task-graph.ts` 最后修改于 `26905a5`）。

## 现象

依赖链本身无环，但节点按倒序传入且上游任务失败时，`runTaskGraph()` 抛出 `Task graph has a dependency cycle`，而不是返回各节点的失败结果。`task_graph` 工具（`packages/runtime/src/index.ts`，并发 3）会把这条误导性错误交给模型。

## 复现

A→B→C 链，按 C、B、A 顺序传入，A 执行失败：

```ts
import { runTaskGraph } from "./packages/core/src/task-graph.ts";
const exec = async (n: { id: string }) => {
  if (n.id === "A") throw Error("A failed");
  return n.id;
};
const chain = [
  { id: "C", dependsOn: ["B"], task: "" },
  { id: "B", dependsOn: ["A"], task: "" },
  { id: "A", dependsOn: [], task: "" },
];
await runTaskGraph(chain, 3, exec, new AbortController().signal);
```

实际输出（Node 26.12.1 直接运行源码）：

```text
C,B,A -> throws: Task graph has a dependency cycle
A,B,C -> {"results":{},"failures":{"A":"Error: A failed","B":"Error: Dependency failed","C":"Error: Dependency failed"}}
```

同一张图只换输入顺序，结果不同。

## 原因

主循环每轮扫描一遍 `pending`，扫描结束后检查：

```ts
if (!running.size && pending.size)
  throw Error("Task graph has a dependency cycle");
```

A 失败后的那一轮扫描：

| 顺序 | 节点 | 判断 | 结果 |
| --- | --- | --- | --- |
| 1 | C | 依赖 B 未失败、未完成 | 跳过，留在 `pending` |
| 2 | B | 依赖 A 已失败 | 标记 `Dependency failed`，移出 `pending` |

扫描结束：`running` 为空，`pending` 还有 C，于是抛错。其实 C 只需要再扫一遍就能看到 B 失败。

这个检查把“本轮没有任务在跑”当成“无法推进”，忽略了本轮刚传播过失败。真正的环在循环开始前的 `visit()` 校验里已经被拒绝，这里的判断只应该捕获“没有任何进展”。

## 建议修复

每轮记录是否有进展（移出节点、传播失败、启动任务）：

```ts
let progressed = false;
for (const [id, node] of pending) {
  // …传播失败或启动任务时 progressed = true
}
if (running.size) await Promise.race(running.values());
else if (pending.size && !progressed) throw Error("Scheduler made no progress");
```

有进展就继续下一轮；既没有在跑的任务、也没有任何进展时才报错。

## 验收

- 倒序链 + A 失败：返回 `failures` = `{A, B: Dependency failed, C: Dependency failed}`，不抛错。
- 正序链行为不变。
- 真正的依赖环仍在启动前被拒绝。
- 回归测试在修复前失败、修复后通过。

教学版复现与修正见 `~/Downloads/hikaro-course/labs/07-task-graph.mjs`（`originalRunTaskGraph` / `runTaskGraph`）。
