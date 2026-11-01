import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { Message } from "../packages/core/src/types.ts";
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
    await agent.steer("one", "owner");
    await agent.steer("two", "owner");
    await agent.steer("remove", "other");
    const release = agent.holdQueue();
    const [a, b, c] = agent.pendingSteering();
    await agent.updateSteering(a!.id, "edited");
    await agent.prioritizeSteering(b!.id);
    await agent.removeSteering(c!.id);
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
    await expect(agent.updateSteering(a!.id, "late")).rejects.toThrow(
      /no longer/,
    );
    await agent.steer("scoped", "other");
    agent.cancelScope("other");
    await agent.queueSettled();
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
    await agent.steer("pending");
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

it("lets a running tool finish, skips the rest of its batch and applies steering next", async () => {
  const store = await SQLiteStore.open(":memory:");
  let finishTool!: () => void;
  let toolStarted!: () => void;
  const started = new Promise<void>((r) => (toolStarted = r));
  const blocked = new Promise<void>((r) => (finishTool = r));
  const tools = new ToolRegistry();
  const ran: string[] = [];
  let aborted = false;
  tools.register({
    name: "slow",
    description: "Waits for the test",
    schema: z.object({}),
    async execute(_args, context) {
      ran.push("slow");
      toolStarted();
      await blocked;
      aborted = !!context?.signal?.aborted;
      return { text: "slow done" };
    },
  });
  tools.register({
    name: "next",
    description: "Should be skipped",
    schema: z.object({}),
    async execute() {
      ran.push("next");
      return { text: "next done" };
    },
  });
  const inputs: Message[][] = [];
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    tools,
    approve: async () => true,
    provider: {
      id: "test",
      model: "test",
      contextWindow: 20000,
      async *stream(input) {
        inputs.push(input.messages);
        yield {
          type: "done" as const,
          message:
            inputs.length === 1
              ? {
                  role: "assistant" as const,
                  text: "",
                  toolCalls: [
                    { id: "a", name: "slow", arguments: {} },
                    { id: "b", name: "next", arguments: {} },
                  ],
                  timestamp: 1,
                }
              : { role: "assistant" as const, text: "ok", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  try {
    const run = agent.prompt("start");
    await started;
    await agent.steer("change course");
    finishTool();
    await run;
    expect(ran).toEqual(["slow"]);
    expect(aborted).toBe(false);
    const second = inputs[1]!;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual(["a", "b"]);
    expect(
      second
        .filter((m) => m.role === "tool")
        .map((m) => [m.callId, m.text, !!m.isError]),
    ).toEqual([
      ["a", "slow done", false],
      ["b", "Skipped: the user sent a new instruction", true],
    ]);
    expect(second.at(-1)).toMatchObject({
      role: "user",
      text: "change course",
    });
    expect(inputs).toHaveLength(2);
  } finally {
    finishTool();
    agent.cancel();
    await agent.queueSettled();
    await store.close();
  }
});
