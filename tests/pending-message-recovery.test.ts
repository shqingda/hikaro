import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("persists pending edits and images, restores without dispatch, and requires the original scope", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-queue-"));
  let store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await store.createSession(home);
  const received: string[] = [];
  const make = () =>
    new Agent({
      session,
      store,
      pendingStore: store,
      tools: new ToolRegistry(),
      approve: async () => false,
      provider: {
        id: "test",
        model: "test",
        contextWindow: 20000,
        async *stream(input) {
          received.push(
            input.messages.filter((m) => m.role === "user").at(-1)!.text,
          );
          yield {
            type: "done" as const,
            message: { role: "assistant" as const, text: "ok", timestamp: 1 },
            usage: { input: 1, output: 1, cost: 0 },
          };
        },
      },
    });
  try {
    const first = make();
    first.holdQueue();
    void first.prompt("one", [{ mimeType: "image/png", data: "fixture" }], {
      scope: "owner",
      commandId: "old",
    });
    void first.prompt("two", undefined, { scope: "owner" });
    await first.queueSettled();
    const [one, two] = first.pendingPrompts();
    await first.updatePending(one!.id, "edited one");
    await first.prioritizePending(two!.id);
    await store.close();
    store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    const restored = make();
    await restored.restorePending();
    expect(
      restored
        .pendingPrompts()
        .map((q) => [q.text, q.recovered, q.attachments]),
    ).toEqual([
      ["two", true, 0],
      ["edited one", true, 1],
    ]);
    expect(restored.snapshot().busy).toBe(false);
    restored.holdQueue()();
    await restored.queueSettled();
    expect(received).toEqual([]);
    await expect(restored.resumePending(one!.id, "other")).rejects.toThrow(
      /identity/,
    );
    await restored.removePending(two!.id);
    await restored.resumePending(one!.id, "owner");
    while (restored.busy) await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual(["edited one"]);
    expect(await store.pendingPrompts(session.id)).toEqual([]);
    const again = make();
    await again.restorePending();
    expect(again.pendingPrompts()).toEqual([]);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("claims each durable message once and deletes pending records with the session", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession(process.cwd());
    await store.insertPendingPrompt(session.id, { id: "one", text: "work" });
    expect(
      await Promise.all([
        store.takePendingPrompt(session.id, "one"),
        store.takePendingPrompt(session.id, "one"),
      ]),
    ).toEqual([true, false]);
    await expect(
      store.updatePendingPrompt(session.id, "one", "late"),
    ).rejects.toThrow(/no longer queued/);
    await store.insertPendingPrompt(session.id, { id: "two", text: "work" });
    await store.deleteSession(session.id);
    expect(await store.pendingPrompts(session.id)).toEqual([]);
  } finally {
    await store.close();
  }
});

it("rejects acceptance when durable storage fails without calling the provider", async () => {
  const store = await SQLiteStore.open(":memory:");
  let calls = 0;
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    pendingStore: store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      id: "test",
      model: "test",
      contextWindow: 20000,
      async *stream() {
        calls++;
      },
    },
  });
  await store.close();
  await expect(agent.enqueuePrompt("must not run")).rejects.toThrow(/closed/);
  expect(agent.pendingPrompts()).toEqual([]);
  expect(calls).toBe(0);
});
