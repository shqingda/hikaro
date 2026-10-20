import { expect, it } from "vitest";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
it("holds queued messages for editing, reorders/removes by ID, then dispatches only retained edits", async () => {
  const store = await SQLiteStore.open(":memory:");
  const received: string[] = [];
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      id: "test",
      model: "test",
      contextWindow: 10000,
      async *stream(input) {
        received.push(
          input.messages.filter((m) => m.role === "user").at(-1)!.text,
        );
        yield {
          type: "done",
          message: { role: "assistant", text: "ok", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  try {
    const release = agent.holdQueue();
    const one = agent.prompt("one");
    const two = agent.prompt("two");
    const three = agent.prompt("three").catch((e) => e.name);
    await agent.queueSettled();
    const [a, b, c] = agent.pendingPrompts();
    await agent.updatePending(b!.id, "edited two");
    await agent.prioritizePending(b!.id);
    await agent.removePending(c!.id);
    expect(agent.pendingPrompts().map((x) => x.text)).toEqual([
      "edited two",
      "one",
    ]);
    expect(received).toEqual([]);
    expect(await three).toBe("AbortError");
    release();
    release();
    await Promise.all([one, two]);
    expect(received).toEqual(["edited two", "one"]);
    await expect(agent.updatePending(a!.id, "late")).rejects.toThrow(
      /no longer queued/,
    );
  } finally {
    agent.cancel();
    await store.close();
  }
});
