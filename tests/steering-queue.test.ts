import { expect, it, vi } from "vitest";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("holds steering until management closes, applies edits in order and rejects consumed IDs", async () => {
  const store = await SQLiteStore.open(":memory:");
  let finishFirst!: () => void;
  const blocked = new Promise<void>((r) => {
    finishFirst = r;
  });
  const inputs: string[][] = [];
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      id: "test",
      model: "test",
      contextWindow: 20000,
      async *stream(input) {
        inputs.push(
          input.messages.filter((m) => m.role === "user").map((m) => m.text),
        );
        if (inputs.length === 1) await blocked;
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, text: "ok", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  try {
    const run = agent.prompt("start");
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    agent.steer("one", "owner");
    agent.steer("two", "owner");
    agent.steer("remove", "other");
    const release = agent.holdQueue();
    const [a, b, c] = agent.pendingSteering();
    agent.updateSteering(a!.id, "edited");
    agent.prioritizeSteering(b!.id);
    agent.removeSteering(c!.id);
    finishFirst();
    await vi.waitFor(async () =>
      expect(
        (await store.messages(agent.options.session.id)).some(
          (m) => m.role === "assistant",
        ),
      ).toBe(true),
    );
    expect(agent.snapshot().runStatus).toBe("running");
    expect(inputs).toHaveLength(1);
    expect(agent.pendingSteering().map((q) => q.text)).toEqual([
      "two",
      "edited",
    ]);
    release();
    const reopened = agent.holdQueue();
    await store.latestSeq(agent.options.session.id);
    expect(agent.pendingSteering()).toHaveLength(2);
    expect(inputs).toHaveLength(1);
    reopened();
    await run;
    expect(inputs).toEqual([["start"], ["start", "two", "edited"]]);
    expect(agent.pendingSteering()).toEqual([]);
    expect(() => agent.updateSteering(a!.id, "late")).toThrow(/no longer/);
    agent.steer("scoped", "other");
    agent.cancelScope("other");
    expect(agent.pendingSteering()).toEqual([]);
  } finally {
    finishFirst();
    agent.cancel();
    await agent.queueSettled();
    await store.close();
  }
});

it("cancels a run waiting for steering management without another provider call", async () => {
  const store = await SQLiteStore.open(":memory:");
  let finish!: () => void,
    calls = 0;
  const blocked = new Promise<void>((done) => {
    finish = done;
  });
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      id: "test",
      model: "test",
      contextWindow: 20000,
      async *stream() {
        calls++;
        await blocked;
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, text: "ok", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  try {
    const run = agent.prompt("start").catch((error) => error.name);
    await vi.waitFor(() => expect(calls).toBe(1));
    const release = agent.holdQueue();
    agent.steer("pending");
    finish();
    await vi.waitFor(async () =>
      expect(
        (await store.messages(agent.options.session.id)).some(
          (m) => m.role === "assistant",
        ),
      ).toBe(true),
    );
    agent.cancel();
    expect(await run).toBe("AbortError");
    release();
    await agent.queueSettled();
    expect(calls).toBe(1);
    expect(agent.pendingSteering()).toEqual([]);
  } finally {
    finish();
    agent.cancel();
    await agent.queueSettled();
    await store.close();
  }
});
