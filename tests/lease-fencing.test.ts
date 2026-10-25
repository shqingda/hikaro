import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  Agent,
  ToolRegistry,
  PluginHost,
  type ProviderAdapter,
} from "../packages/core/src/index.ts";
import { z } from "zod";
import { codingPlugin } from "../packages/tools/src/index.ts";

const stores: SQLiteStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(legacy = false) {
  const dir = await mkdtemp(join(tmpdir(), "hikaro-fence-"));
  directories.push(dir);
  const path = join(dir, "sessions.sqlite");
  if (legacy) {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE leases(sessionId TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
    db.close();
  }
  const first = await SQLiteStore.open(path);
  stores.push(first);
  const session = await first.createSession(dir);
  const second = await SQLiteStore.open(path);
  stores.push(second);
  await second.session(session.id);
  const expire = () => {
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE leases SET expires=0 WHERE sessionId=?").run(
        session.id,
      );
    } finally {
      db.close();
    }
  };
  return { first, second, session, expire, path };
}

it("rejects an expired owner's append in the database transaction", async () => {
  const { first, session, expire } = await fixture();
  const lease = (await first.acquireLease(session.id, "old-owner"))!;
  expect(lease.owner).toBe("old-owner");
  expire();
  await expect(
    first.append(
      session.id,
      "message",
      { text: "stale" },
      lease,
    ),
  ).rejects.toThrow(/lease/i);
  expect(await first.events(session.id)).toEqual([]);
});

it("does not revive an expired lease by acquiring again with the same owner", async () => {
  const { first, session, expire } = await fixture();
  expect(await first.acquireLease(session.id, "old-owner")).toMatchObject({
    owner: "old-owner",
  });
  expire();
  expect(await first.acquireLease(session.id, "old-owner")).toBeUndefined();
});

it("rejects unowned appends while another connection holds the session lease", async () => {
  const { first, second, session } = await fixture();
  expect(await first.acquireLease(session.id, "owner")).toMatchObject({
    owner: "owner",
  });
  await expect(
    second.append(session.id, "message", { text: "unowned" }),
  ).rejects.toThrow(/lease/i);
  expect(await second.events(session.id)).toEqual([]);
});

it("fences an old epoch after takeover and keeps the successor lease intact", async () => {
  const { first, second, session, expire } = await fixture();
  const old = (await first.acquireLease(session.id, "old-owner"))!;
  expect(old.epoch).toBeGreaterThan(0);
  await first.append(session.id, "test", { valid: true }, old);
  expect(await first.renewLease(session.id, old)).toBe(true);
  expire();
  expect(await first.renewLease(session.id, old)).toBe(false);
  const successor = (await second.acquireLease(session.id, "new-owner"))!;
  expect(successor.epoch).toBeGreaterThan(old.epoch);
  await expect(
    first.append(session.id, "test", { stale: true }, old),
  ).rejects.toThrow(/lease/i);
  await first.releaseLease(session.id, old);
  await second.assertLease(session.id, successor);
  await second.append(session.id, "test", { successor: true }, successor);
  expect((await first.events(session.id)).map((event) => event.data)).toEqual([
    { valid: true },
    { successor: true },
  ]);
  await second.releaseLease(session.id, successor);
  const reusedOwner = (await first.acquireLease(session.id, old.owner))!;
  expect(reusedOwner.epoch).toBeGreaterThan(successor.epoch);
  await expect(first.assertLease(session.id, old)).rejects.toThrow(/lease/i);
  await first.append(session.id, "test", { reusedOwner: true }, reusedOwner);
  await first.releaseLease(session.id, reusedOwner);
  await second.append(session.id, "test", { idle: true });
  await expect(
    second.append(session.id, "test", { stale: true }, successor),
  ).rejects.toThrow(/lease/i);
});

const provider: ProviderAdapter = {
  id: "test",
  model: "test",
  contextWindow: 10000,
  async *stream() {
    yield {
      type: "done",
      message: { role: "assistant", text: "Done", timestamp: 1 },
      usage: { input: 1, output: 1, cost: 0 },
    };
  },
};

it("attaches its lease to prompt, manual-tool, and compaction events", async () => {
  const { first, session } = await fixture();
  const tools = new ToolRegistry();
  tools.register({
    name: "test",
    description: "test",
    schema: z.object({}),
    execute: async () => ({ text: "Done" }),
  });
  const agent = new Agent({
    session,
    store: first,
    tools,
    provider,
    approve: async () => true,
  });
  await agent.prompt("Task");
  await agent.executeTool("test", {}, "Manual task");
  await agent.compact();
  expect(
    (await first.events(session.id))
      .filter((event) => event.type === "run.end")
      .map((event) => event.data.status),
  ).toEqual(["completed", "completed", "completed"]);
  expect(agent.snapshot().busy).toBe(false);
});

it("stops before a tool side effect when its approval outlives its lease", async () => {
  const { first, second, session, expire } = await fixture();
  let approved!: () => void;
  let waiting!: () => void;
  const approval = new Promise<void>((resolve) => {
    approved = resolve;
  });
  const approvalStarted = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let effects = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "effect",
    description: "side effect",
    schema: z.object({}),
    execute: async (_args, ctx) => {
      if (await ctx.approve("Run side effect")) effects++;
      return { text: "Done" };
    },
  });
  const agent = new Agent({
    session,
    store: first,
    tools,
    provider,
    approve: async () => {
      waiting();
      await approval;
      return true;
    },
  });
  const work = agent.executeTool("effect", {}, "Manual side effect");
  const rejected = expect(work).rejects.toThrow(/lease/i);
  await approvalStarted;
  expire();
  const successor = (await second.acquireLease(session.id, "successor"))!;
  approved();
  await rejected;
  expect(effects).toBe(0);
  await second.assertLease(session.id, successor);
  expect(agent.snapshot().busy).toBe(false);
  expect(
    (await first.events(session.id)).some((event) => event.type === "tool.end"),
  ).toBe(false);
});

it("does not commit a file update that waits until after lease takeover", async () => {
  const { first, second, session, expire } = await fixture();
  const path = join(await fs.realpath(session.cwd), "source.txt");
  await fs.writeFile(path, "original");
  const tools = new ToolRegistry();
  await new PluginHost(tools).load(codingPlugin({ trusted: true }));
  const agent = new Agent({
    session,
    store: first,
    tools,
    provider,
    approve: async () => true,
  });
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const tool = tools.get("write_file")!;
  const execute = tool.execute;
  tool.execute = (args, ctx) =>
    execute(args, {
      ...ctx,
      checkpoint: async () => {
        entered();
        await paused;
        await ctx.checkpoint?.();
      },
    });
  const work = agent.executeTool(
    "write_file",
    { path, expected: "original", content: "stale owner update" },
    "Update source file",
  );
  const rejected = expect(work).rejects.toThrow(/lease/i);
  try {
    await waiting;
    expire();
    const successor = (await second.acquireLease(session.id, "successor"))!;
    resume();
    await rejected;
    expect(await fs.readFile(path, "utf8")).toBe("original");
    await second.assertLease(session.id, successor);
    await expect(fs.stat(path + ".hikaro-lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    resume();
    await work.catch(() => {});
  }
});

it("checks renewal expiry after obtaining the writer lock", async () => {
  const { first, session, path } = await fixture();
  const lease = (await first.acquireLease(session.id, "owner"))!;
  const blocker = new DatabaseSync(path);
  try {
    blocker
      .prepare("UPDATE leases SET expires=? WHERE sessionId=?")
      .run(Date.now() + 60, session.id);
    blocker.exec("BEGIN IMMEDIATE");
    const renewal = first.renewLease(session.id, lease);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    blocker.exec("COMMIT");
    expect(await renewal).toBe(false);
  } finally {
    blocker.close();
  }
});

it("migrates an existing lease table before issuing fenced tokens", async () => {
  const { first, second, session, path } = await fixture(true);
  const lease = (await first.acquireLease(session.id, "owner"))!;
  expect(lease).toEqual({ owner: "owner", epoch: 1 });
  await first.append(session.id, "test", { migrated: true }, lease);
  await expect(second.append(session.id, "test", {})).rejects.toThrow(/lease/i);
  const db = new DatabaseSync(path);
  try {
    expect(
      db.prepare("SELECT epoch FROM leases WHERE sessionId=?").get(session.id)
        ?.epoch,
    ).toBe(1);
  } finally {
    db.close();
  }
});

it("refuses provider output and terminal events after another process takes over", async () => {
  const { first, second, session, expire } = await fixture();
  let started!: () => void;
  let resume!: () => void;
  let requestSignal: AbortSignal | undefined;
  const streaming = new Promise<void>((resolve) => {
    started = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const agent = new Agent({
    session,
    store: first,
    tools: new ToolRegistry(),
    approve: async () => true,
    provider: {
      ...provider,
      async *stream(input) {
        requestSignal = input.signal;
        started();
        await paused;
        yield { type: "text", text: "stale output" };
        yield {
          type: "done",
          message: { role: "assistant", text: "stale output", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  const work = agent.prompt("Task");
  const rejected = expect(work).rejects.toThrow(/lease/i);
  await streaming;
  expire();
  const successor = (await second.acquireLease(session.id, "successor"))!;
  await second.append(
    session.id,
    "successor.event",
    { valid: true },
    successor,
  );
  resume();
  await rejected;
  const events = await second.events(session.id);
  expect(events.at(-1)?.type).toBe("successor.event");
  expect(
    events.some(
      (event) => event.type === "run.end" || event.type === "text.delta",
    ),
  ).toBe(false);
  expect(
    (await second.messages(session.id)).map((message) => message.role),
  ).toEqual(["user"]);
  expect(agent.snapshot().busy).toBe(false);
  expect(requestSignal?.aborted).toBe(true);
  await second.assertLease(session.id, successor);
});

it("clears queue ownership before a failed final prompt rejects", async () => {
  const { first, session } = await fixture();
  const agent = new Agent({
    session,
    store: first,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      ...provider,
      async *stream() {
        throw Error("fixture failure");
      },
    },
  });
  await expect(agent.prompt("fail")).rejects.toThrow("fixture failure");
  expect(agent.busy).toBe(false);
});

it("settles each queued prompt independently while keeping later work exclusive", async () => {
  const { first, session } = await fixture();
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const started = gate(),
    finishFirst = gate(),
    finishSecond = gate();
  let calls = 0;
  const agent = new Agent({
    session,
    store: first,
    pendingStore: first,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      ...provider,
      async *stream(input) {
        const call = ++calls;
        if (call === 1) started.resolve();
        await (call === 1 ? finishFirst : finishSecond).promise;
        yield* provider.stream(input);
      },
    },
  });
  const one = await agent.enqueuePrompt("one");
  await started.promise;
  const two = await agent.enqueuePrompt("two");
  try {
    finishFirst.resolve();
    await one.completion;
    expect(agent.busy).toBe(true);
    await expect(
      agent.executeTool("unused", {}, "must not interleave"),
    ).rejects.toThrow("Wait for the active run");
    finishSecond.resolve();
    await two.completion;
    expect(agent.busy).toBe(false);
    expect(calls).toBe(2);
    expect(agent.pendingPrompts()).toEqual([]);
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    await Promise.allSettled([one.completion, two.completion]);
  }
});
