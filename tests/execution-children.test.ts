import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import type { ToolContext } from "../packages/core/src/types.ts";
import { executionItems } from "../packages/runtime/src/execution-items.ts";
it("retains a real child outcome under its parent and rejects cross-session control", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-children-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  try {
    const parent = await runtime.session();
    expect(runtime.childTasks(parent.id)).toEqual([]);
    const ctx = {
      cwd: home,
      sessionId: parent.id,
      signal: new AbortController().signal,
      depth: 0,
      budget: {
        usage: { input: 0, output: 0, cost: 0 },
        maxCost: 1,
        modelCallsLeft: 5,
      },
    } as unknown as ToolContext;
    await runtime.tools.get("subagent")!.execute({ task: "Say hello" }, ctx);
    const [child] = runtime.childTasks(parent.id);
    expect(child).toMatchObject({ task: "Say hello", state: "completed" });
    expect(child!.output.length).toBeGreaterThan(0);
    expect(runtime.childTasks("other")).toEqual([]);
    expect(() => runtime.stopChild("other", child!.id)).toThrow(/not found/);
    runtime.stopChild(parent.id, child!.id);
    expect(runtime.childTasks(parent.id)[0]!.state).toBe("completed");
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("lists nested child agents under the root session in tree order", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-children-tree-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  try {
    const parent = await runtime.session();
    const context = (sessionId: string, depth: number) =>
      ({
        cwd: home,
        sessionId,
        signal: new AbortController().signal,
        depth,
        budget: {
          usage: { input: 0, output: 0, cost: 0 },
          maxCost: 1,
          modelCallsLeft: 10,
        },
      }) as unknown as ToolContext;
    const subagent = runtime.tools.get("subagent")!;
    await subagent.execute({ task: "First child" }, context(parent.id, 0));
    const [first] = runtime.childTasks(parent.id);
    // The child session delegates once more, as a nested subagent would.
    await subagent.execute({ task: "Grandchild" }, context(first!.id, 1));
    await subagent.execute({ task: "Second child" }, context(parent.id, 0));
    const tree = runtime.childTasks(parent.id);
    expect(
      tree.map((t) => [t.task, t.depth, t.parentId === parent.id]),
    ).toEqual([
      ["First child", 1, true],
      ["Grandchild", 2, false],
      ["Second child", 1, true],
    ]);
    expect(tree[1]!.parentId).toBe(first!.id);
    // The child still sees only its own subtree.
    expect(runtime.childTasks(first!.id).map((t) => [t.task, t.depth])).toEqual(
      [["Grandchild", 1]],
    );
    const items = executionItems(
      { pendingPrompts: () => [], pendingSteering: () => [] },
      runtime,
      parent.id,
      "children",
    );
    expect(items.map((item) => item.title)).toEqual([
      "First child",
      "  ↳ Grandchild",
      "Second child",
    ]);
    expect(items[1]!.state).toBe("completed · level 2");
    expect(items[1]!.detail).toContain(
      `Delegated by child agent ${first!.id.slice(0, 8)}`,
    );
    expect(() => runtime.stopChild(parent.id, tree[1]!.id)).not.toThrow();
    expect(() => runtime.stopChild(tree[2]!.id, tree[1]!.id)).toThrow(
      /not found/,
    );
    expect(() => runtime.stopChild("other", tree[1]!.id)).toThrow(/not found/);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
