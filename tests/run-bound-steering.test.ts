import { afterEach, expect, it, vi } from "vitest";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function fixture() {
  const store = await SQLiteStore.open(":memory:");
  const first = deferred();
  const inputs: string[][] = [];
  let fail = false;
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    steeringStore: store,
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
        if (inputs.length === 1) {
          await first.promise;
          if (fail) throw Error("Provider failed");
        }
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, text: "done", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  cleanups.push(async () => {
    first.resolve();
    agent.cancel();
    await agent.queueSettled();
    await vi.waitFor(() => expect(agent.busy).toBe(false));
    await store.close();
  });
  return {
    store,
    agent,
    inputs,
    first,
    fail: () => {
      fail = true;
    },
  };
}

it("rejects a stale run without changing legacy idle steering", async () => {
  const { agent } = await fixture();
  await expect(agent.steer("expired", "owner", "old-run")).rejects.toThrow(
    /no longer active/i,
  );
  expect(agent.pendingSteering()).toEqual([]);
  await agent.steer("legacy", "owner");
  expect(agent.pendingSteering().map((item) => item.text)).toEqual(["legacy"]);
});

it("applies a matching intervention at the next turn and rejects another run", async () => {
  const { agent, inputs, first } = await fixture();
  const run = agent.prompt("start");
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  await expect(agent.steer("wrong", "owner", "another-run")).rejects.toThrow(
    /no longer active/i,
  );
  await agent.steer("intervene", "owner", agent.snapshot().runId!);
  first.resolve();
  await run;
  expect(inputs).toEqual([["start"], ["start", "intervene"]]);
  expect(agent.pendingSteering()).toEqual([]);
});

it("checks run identity after waiting for the queue serializer", async () => {
  const { agent, store, inputs, first, fail } = await fixture();
  const run = agent.prompt("start").catch((error: Error) => error.message);
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  const runId = agent.snapshot().runId!;
  const insertion = deferred();
  const insert = store.insertPendingSteering.bind(store);
  const saving = vi
    .spyOn(store, "insertPendingSteering")
    .mockImplementationOnce(async (...args) => {
      await insertion.promise;
      await insert(...args);
    });
  const legacy = agent.steer("legacy", "owner");
  await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());
  const intervention = agent
    .steer("expired", "owner", runId)
    .catch((error: Error) => error.message);
  try {
    fail();
    first.resolve();
    expect(await run).toBe("Provider failed");
  } finally {
    insertion.resolve();
  }
  await legacy;
  expect(await intervention).toMatch(/no longer active/i);
  expect(agent.pendingSteering().map((item) => item.text)).toEqual(["legacy"]);
});

it("closes intervention admission before the terminal event finishes saving", async () => {
  const { agent, store, inputs, first } = await fixture();
  const terminal = deferred();
  const saving = deferred();
  const append = store.append.bind(store);
  vi.spyOn(store, "append").mockImplementation(async (...args) => {
    if (args[1] === "run.end") {
      saving.resolve();
      await terminal.promise;
    }
    return append(...args);
  });
  const run = agent.prompt("start");
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  const runId = agent.snapshot().runId!;
  first.resolve();
  await saving.promise;
  try {
    await expect(agent.steer("too late", "owner", runId)).rejects.toThrow(
      /no longer active/i,
    );
  } finally {
    terminal.resolve();
  }
  await run;
  expect(agent.pendingSteering()).toEqual([]);
});

it("keeps an unapplied intervention for explicit recovery after its run fails", async () => {
  const { agent, inputs, first, fail, store } = await fixture();
  const run = agent.prompt("start").catch((error: Error) => error.message);
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  await agent.steer("do not leak", "owner", agent.snapshot().runId!);
  fail();
  first.resolve();
  expect(await run).toBe("Provider failed");
  expect(agent.pendingSteering()).toMatchObject([
    {
      text: "do not leak",
      recovered: true,
      error: expect.stringMatching(/run.*ended/i),
    },
  ]);
  await agent.prompt("unrelated request");
  expect(inputs[1]).toEqual(["start", "unrelated request"]);
  expect(await store.pendingSteering(agent.options.session.id)).toMatchObject([
    { text: "do not leak" },
  ]);
  const restored = new Agent(agent.options);
  await restored.restorePending();
  expect(restored.pendingSteering()).toMatchObject([
    { text: "do not leak", recovered: true },
  ]);
  await restored.prompt("after restart");
  expect(inputs.at(-1)).not.toContain("do not leak");
});

it("quarantines a guarded insert that finishes after its run failed", async () => {
  const { agent, store, inputs, first, fail } = await fixture();
  const run = agent.prompt("start").catch((error: Error) => error.message);
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  const inserting = deferred();
  const saved = deferred();
  const insert = store.insertPendingSteering.bind(store);
  vi.spyOn(store, "insertPendingSteering").mockImplementationOnce(
    async (...args) => {
      await insert(...args);
      saved.resolve();
      await inserting.promise;
    },
  );
  const intervention = agent
    .steer("too late", "owner", agent.snapshot().runId!)
    .catch((error: Error) => error.message);
  await saved.promise;
  try {
    fail();
    first.resolve();
    expect(await run).toBe("Provider failed");
  } finally {
    inserting.resolve();
  }
  expect(await intervention).toMatch(/no longer active/i);
  expect(agent.pendingSteering()).toMatchObject([
    { text: "too late", recovered: true },
  ]);
  await agent.prompt("next");
  expect(inputs.at(-1)).not.toContain("too late");
});

it("cancels only the expected active run", async () => {
  const { agent, inputs, first } = await fixture();
  const run = agent.prompt("start").catch((error: Error) => error.name);
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  expect(() => agent.cancelRun("another-run")).toThrow(/no longer active/i);
  expect(agent.snapshot().runStatus).toBe("running");
  agent.cancelRun(agent.snapshot().runId!);
  first.resolve();
  expect(await run).toBe("AbortError");
  expect(() => agent.cancelRun(agent.snapshot().runId!)).toThrow(
    /no longer active/i,
  );
});
