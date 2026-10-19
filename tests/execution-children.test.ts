import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import type { ToolContext } from "../packages/core/src/types.ts";
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
