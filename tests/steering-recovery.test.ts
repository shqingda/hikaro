import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import type { PendingSteeringStore } from "../packages/core/src/steering-queue.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-steering-recovery-"));
  const path = join(home, "sessions.sqlite");
  const store = await SQLiteStore.open(path);
  cleanups.push(async () => {
    await store.close();
    await rm(home, { recursive: true, force: true });
  });
  const session = await store.createSession(home);
  const inputs: string[][] = [];
  const makeAgent = (steeringStore: PendingSteeringStore = store) =>
    new Agent({
      session,
      store,
      steeringStore,
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
          yield {
            type: "done" as const,
            message: { role: "assistant" as const, text: "ok", timestamp: 1 },
            usage: { input: 1, output: 1, cost: 0 },
          };
        },
      },
    });
  return { path, store, session, inputs, makeAgent };
}

it("durably restores edits and order, requires the original identity and never starts a run on confirmation", async () => {
  const { store, session, inputs, makeAgent } = await fixture();
  const original = makeAgent();
  await original.steer("one", "owner");
  await original.steer("two", "owner");
  await original.steer("remove", "owner");
  const [a, b, c] = original.pendingSteering();
  await original.updateSteering(a!.id, "edited 中文");
  await original.prioritizeSteering(b!.id);
  await original.removeSteering(c!.id);
  const restored = makeAgent();
  await restored.restorePending();
  expect(restored.pendingSteering().map((q) => [q.text, q.recovered])).toEqual([
    ["two", true],
    ["edited 中文", true],
  ]);
  await restored.prompt("new explicit prompt");
  expect(inputs).toEqual([["new explicit prompt"]]);
  await expect(restored.resumeSteering(b!.id, "another")).rejects.toThrow(
    /original client identity/,
  );
  await restored.resumeSteering(b!.id, "owner");
  expect(inputs).toHaveLength(1);
  await restored.prompt("apply confirmed only");
  expect(inputs[1]).toEqual([
    "new explicit prompt",
    "apply confirmed only",
    "two",
  ]);
  expect((await store.pendingSteering(session.id)).map((q) => q.text)).toEqual([
    "edited 中文",
  ]);
  restored.cancel(true);
  await restored.queueSettled();
  expect(await store.pendingSteering(session.id)).toHaveLength(1);
  const restarted = makeAgent();
  await restarted.restorePending();
  await restarted.resumeSteering(a!.id, "owner");
  restarted.cancel();
  await restarted.queueSettled();
  expect(await store.pendingSteering(session.id)).toEqual([]);
});

it("commits consumption and history atomically, fences stale leases and cannot consume twice", async () => {
  const { path, store, session } = await fixture();
  const item = { id: "atomic", text: "saved text", scope: "owner" };
  await store.insertPendingSteering(session.id, item);
  const lease = (await store.acquireLease(session.id, "consumer"))!;
  await expect(
    store.consumePendingSteering(session.id, item.id, {
      ...lease,
      epoch: lease.epoch + 1,
    }),
  ).rejects.toThrow(/lease lost/);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER reject_steering BEFORE INSERT ON events WHEN NEW.type='message' BEGIN SELECT RAISE(ABORT,'disk write failed'); END;",
    );
    await expect(
      store.consumePendingSteering(session.id, item.id, lease),
    ).rejects.toThrow(/disk write failed/);
    expect(await store.pendingSteering(session.id)).toEqual([item]);
    expect(await store.messages(session.id)).toEqual([]);
    db.exec("DROP TRIGGER reject_steering");
  } finally {
    db.close();
  }
  await store.updatePendingSteering(session.id, item.id, "latest saved text");
  const event = await store.consumePendingSteering(session.id, item.id, lease);
  expect(event?.data.message).toMatchObject({
    role: "user",
    text: "latest saved text",
  });
  expect(
    await store.consumePendingSteering(session.id, item.id, lease),
  ).toBeUndefined();
  expect(await store.pendingSteering(session.id)).toEqual([]);
  expect(await store.messages(session.id)).toHaveLength(1);
  await store.releaseLease(session.id, lease);
});

it.each(["cancel", "revoke"])(
  "does not resurrect an insertion racing %s",
  async (action) => {
    const { store, session, makeAgent, inputs } = await fixture();
    const insert = store.insertPendingSteering.bind(store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserting = vi
      .spyOn(store, "insertPendingSteering")
      .mockImplementation(async (...args) => {
        await insert(...args);
        await held;
      });
    const agent = makeAgent();
    const accepted = agent
      .steer("must not execute", "revoked")
      .catch((error) => error.name);
    try {
      await vi.waitFor(() => expect(inserting).toHaveBeenCalledOnce());
      if (action === "cancel") agent.cancel();
      else agent.cancelScope("revoked");
    } finally {
      release();
    }
    expect(await accepted).toBe("AbortError");
    await agent.queueSettled();
    expect(await store.pendingSteering(session.id)).toEqual([]);
    await agent.prompt("safe new request");
    expect(inputs).toEqual([["safe new request"]]);
  },
);

it("quarantines a failed cancellation visibly and leaves it recoverable without auto-consumption", async () => {
  const { store, session, makeAgent, inputs } = await fixture();
  const agent = makeAgent();
  await agent.steer("retained after disk failure", "owner");
  const take = vi
    .spyOn(store, "takePendingSteering")
    .mockRejectedValue(Error("disk unavailable"));
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    agent.cancelScope("owner");
    await agent.queueSettled();
    expect(agent.pendingSteering()[0]).toMatchObject({
      recovered: true,
      error: expect.stringContaining("disk unavailable"),
    });
    await agent.prompt("unrelated request");
    expect(inputs).toEqual([["unrelated request"]]);
    expect(await store.pendingSteering(session.id)).toHaveLength(1);
  } finally {
    take.mockRestore();
    logging.mockRestore();
  }
  agent.cancel();
  await agent.queueSettled();
  expect(await store.pendingSteering(session.id)).toEqual([]);
});

it("enforces the durable limit across connections and deletes steering with its session", async () => {
  const { path, store, session } = await fixture();
  const other = await SQLiteStore.open(path);
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? store : other).insertPendingSteering(session.id, {
          id: `item-${i}`,
          text: "pending",
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(16);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(4);
    await store.deleteSession(session.id);
    expect(await other.pendingSteering(session.id)).toEqual([]);
  } finally {
    await other.close();
  }
});
