import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  Agent,
  ToolRegistry,
  type Message,
  type ProviderAdapter,
} from "../packages/core/src/index.ts";

const stores: SQLiteStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const message = (role: Message["role"], text: string): Message => ({
  role,
  text,
  timestamp: 1,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hikaro-auto-compact-"));
  directories.push(directory);
  const path = join(directory, "history.sqlite");
  const store = await SQLiteStore.open(path);
  stores.push(store);
  const session = await store.createSession(directory);
  return { store, session, path };
}
async function seed(store: SQLiteStore, id: string) {
  await store.append(id, "message", {
    message: message("user", "Keep the public API; source src/api.ts"),
  });
  const old = await store.append(id, "message", {
    message: message("assistant", "Inspected src/api.ts"),
  });
  const current = await store.append(id, "message", {
    message: message("user", "Continue the current task"),
  });
  return {
    throughSeq: old.seq,
    expectedLastMessageSeq: current.seq,
    expectedCheckpointSeq: 0,
    summary: "Preserve public API; inspected src/api.ts.",
  };
}

describe("transactional context checkpoints", () => {
  it("recovers a committed checkpoint without changing original messages", async () => {
    const { store, session, path } = await fixture();
    const original = await seed(store, session.id);
    const before = await store.messagePage(session.id, { after: 0, limit: 20 });
    const lease = (await store.acquireLease(session.id, "owner"))!;
    const checkpoint = await store.commitContextCheckpoint(
      session.id,
      original,
      lease,
    );
    await store.releaseLease(session.id, lease);
    const reopened = await SQLiteStore.open(path);
    stores.push(reopened);
    const restored = await reopened.contextHistory(session.id);
    expect(restored.checkpoint).toEqual(checkpoint);
    expect(restored.messages.map((m) => m.text)).toEqual([
      "Continue the current task",
    ]);
    expect(
      await reopened.messagePage(session.id, { after: 0, limit: 20 }),
    ).toEqual(before);
    expect(
      (await reopened.events(session.id)).filter(
        (event) => event.type === "context.checkpoint",
      ),
    ).toHaveLength(1);
  });

  it("rejects stale source versions without changing the checkpoint", async () => {
    const { store, session } = await fixture();
    const candidate = await seed(store, session.id);
    const lease = (await store.acquireLease(session.id, "owner"))!;
    await store.append(
      session.id,
      "message",
      { message: message("assistant", "A newer result") },
      lease,
    );
    await expect(
      store.commitContextCheckpoint(session.id, candidate, lease),
    ).rejects.toThrow(/changed/i);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
    expect(
      (await store.events(session.id)).some(
        (event) => event.type === "context.checkpoint",
      ),
    ).toBe(false);
  });

  it("rejects a checkpoint boundary that separates a tool call from its result", async () => {
    const { store, session } = await fixture();
    await store.append(session.id, "message", {
      message: message("user", "Inspect"),
    });
    const call = await store.append(session.id, "message", {
      message: {
        ...message("assistant", ""),
        toolCalls: [
          { id: "read", name: "read_file", arguments: { path: "src/api.ts" } },
        ],
      },
    });
    await store.append(session.id, "message", {
      message: {
        ...message("tool", "source"),
        callId: "read",
        name: "read_file",
      },
    });
    const latest = await store.append(session.id, "message", {
      message: message("user", "Continue"),
    });
    const lease = (await store.acquireLease(session.id, "owner"))!;
    await expect(
      store.commitContextCheckpoint(
        session.id,
        {
          summary: "Read source",
          throughSeq: call.seq,
          expectedCheckpointSeq: 0,
          expectedLastMessageSeq: latest.seq,
        },
        lease,
      ),
    ).rejects.toThrow(/user.turn boundary/i);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it("fences checkpoint commits after the lease expires", async () => {
    const { store, session, path } = await fixture();
    const candidate = await seed(store, session.id);
    const lease = (await store.acquireLease(session.id, "old"))!;
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE leases SET expires=0 WHERE sessionId=?").run(
        session.id,
      );
    } finally {
      db.close();
    }
    await expect(
      store.commitContextCheckpoint(session.id, candidate, lease),
    ).rejects.toThrow(/lease/i);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it("rolls back the audit event when writing the checkpoint fails", async () => {
    const { store, session, path } = await fixture();
    const candidate = await seed(store, session.id);
    const before = await store.messagePage(session.id, { after: 0, limit: 20 });
    const lease = (await store.acquireLease(session.id, "owner"))!;
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON context_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END",
      );
    } finally {
      db.close();
    }
    await expect(
      store.commitContextCheckpoint(session.id, candidate, lease),
    ).rejects.toThrow(/fixture checkpoint failure/);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
    expect(
      (await store.events(session.id)).some(
        (event) => event.type === "context.checkpoint",
      ),
    ).toBe(false);
    expect(
      await store.messagePage(session.id, { after: 0, limit: 20 }),
    ).toEqual(before);
  });

  it("rejects a cancelled checkpoint while its write is queued behind another transaction", async () => {
    const { store, session, path } = await fixture();
    const candidate = await seed(store, session.id);
    const lease = (await store.acquireLease(session.id, "owner"))!;
    const controller = new AbortController();
    const db = new DatabaseSync(path);
    db.exec("BEGIN IMMEDIATE");
    let committed: Promise<unknown>;
    try {
      committed = store.commitContextCheckpoint(
        session.id,
        candidate,
        lease,
        controller.signal,
      );
      controller.abort();
    } finally {
      db.exec("COMMIT");
      db.close();
    }
    await expect(committed).rejects.toMatchObject({ name: "AbortError" });
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
    expect(
      (await store.events(session.id)).some(
        (event) => event.type === "context.checkpoint",
      ),
    ).toBe(false);
  });

  it("rejects a stale checkpoint version even if the message source has not changed", async () => {
    const { store, session } = await fixture();
    const candidate = await seed(store, session.id);
    const lease = (await store.acquireLease(session.id, "owner"))!;
    const saved = await store.commitContextCheckpoint(
      session.id,
      candidate,
      lease,
    );
    await expect(
      store.commitContextCheckpoint(session.id, candidate, lease),
    ).rejects.toThrow(/changed/i);
    expect((await store.contextHistory(session.id)).checkpoint).toEqual(saved);
  });
});

describe("automatic compaction", () => {
  async function agentFixture(
    options: {
      summary?: (
        input: Parameters<ProviderAdapter["stream"]>[0],
      ) => Promise<string> | string;
      reply?: (
        input: Parameters<ProviderAdapter["stream"]>[0],
        call: number,
      ) => Message;
      oldLength?: number;
      budget?: {
        usage: { input: number; output: number; cost: number };
        maxCost: number;
        modelCallsLeft: number;
      };
    } = {},
  ) {
    const { store, session, path } = await fixture();
    await store.append(session.id, "message", {
      message: message(
        "user",
        "ORIGINAL_SOURCE: Preserve public API at src/api.ts",
      ),
    });
    await store.append(session.id, "message", {
      message: message("assistant", "x".repeat(options.oldLength ?? 12000)),
    });
    const summaries: Array<Parameters<ProviderAdapter["stream"]>[0]> = [];
    const requests: Array<Parameters<ProviderAdapter["stream"]>[0]> = [];
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 6000,
      maxOutputTokens: 1200,
      async *stream(input) {
        const summarizing = input.system.startsWith(
          "Create a faithful continuation summary",
        );
        if (summarizing) summaries.push(input);
        else requests.push(input);
        yield {
          type: "done",
          message: summarizing
            ? message(
                "assistant",
                await (options.summary?.(input) ??
                  "Preserve public API. Source src/api.ts inspected; unfinished work remains."),
              )
            : (options.reply?.(input, requests.length) ??
              message("assistant", "Completed")),
          usage: { input: 10, output: 5, cost: 0.01 },
        };
      },
    };
    const tools = new ToolRegistry();
    const agent = new Agent({
      store,
      session,
      provider,
      tools,
      system: "Inspect before editing.",
      budget: options.budget,
      approve: async () => false,
    });
    return {
      store,
      session,
      path,
      agent,
      provider,
      tools,
      summaries,
      requests,
    };
  }

  it("creates a same-session checkpoint before answering near the request limit and resumes it after restart", async () => {
    const { store, session, path, agent, provider, summaries, requests } =
      await agentFixture();
    await agent.prompt("CURRENT_TASK: continue safely");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((input) => input.tools.length === 0)).toBe(true);
    expect(
      summaries.map((input) => input.messages[0]!.text).join(""),
    ).toContain("ORIGINAL_SOURCE");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.text).toContain("src/api.ts");
    expect(requests[0]!.messages.at(-1)!.text).toBe(
      "CURRENT_TASK: continue safely",
    );
    const checkpoint = (await store.contextHistory(session.id)).checkpoint!;
    expect(checkpoint.summary).toContain("public API");
    expect((await store.sessions()).map((item) => item.id)).toEqual([
      session.id,
    ]);
    expect(
      (await store.messagePage(session.id, { after: 0, limit: 10 })).items[0]!
        .message.text,
    ).toContain("ORIGINAL_SOURCE");
    const reopened = await SQLiteStore.open(path);
    stores.push(reopened);
    const resumed = new Agent({
      store: reopened,
      session,
      provider,
      tools: new ToolRegistry(),
      system: "Inspect before editing.",
      approve: async () => false,
    });
    const summaryCalls = summaries.length;
    await resumed.prompt("NEXT_TASK");
    expect(summaries).toHaveLength(summaryCalls);
    expect(requests.at(-1)!.messages[0]!.text).toContain("src/api.ts");
    expect((await reopened.contextHistory(session.id)).checkpoint).toEqual(
      checkpoint,
    );
  });

  it("compacts prior turns during a tool loop without changing the current tool pair or replaying the tool", async () => {
    const call = { id: "read-current", name: "read_file", arguments: {} };
    const { agent, tools, summaries, requests } = await agentFixture({
      oldLength: 9000,
      reply: (_input, callNumber) =>
        callNumber === 1
          ? { ...message("assistant", ""), toolCalls: [call] }
          : message("assistant", "Finished"),
    });
    let effects = 0;
    tools.register({
      name: "read_file",
      description: "Inspect current source",
      schema: z.object({}),
      execute: async () => {
        effects++;
        return { text: "y".repeat(3000) };
      },
    });
    await agent.prompt("Current constraint must survive");
    expect(summaries.length).toBeGreaterThan(0);
    expect(effects).toBe(1);
    const tail = requests.at(-1)!.messages.slice(-3);
    expect(tail[0]!.text).toBe("Current constraint must survive");
    expect(tail[1]!.toolCalls).toEqual([call]);
    expect(tail[2]).toMatchObject({
      callId: call.id,
      name: call.name,
      text: "y".repeat(3000),
    });
  });

  it("does not activate an empty summary or fall back to silently dropping source", async () => {
    const { store, session, agent, requests } = await agentFixture({
      summary: () => "",
    });
    await expect(agent.prompt("Continue")).rejects.toThrow(
      /summary was empty/i,
    );
    expect(requests).toHaveLength(0);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
    expect(
      (await store.messages(session.id)).filter((m) => m.role === "assistant"),
    ).toHaveLength(1);
  });

  it("does not activate a summary returned after cancellation", async () => {
    let cancel = () => {};
    const { store, session, agent, requests } = await agentFixture({
      summary: () => {
        cancel();
        return "Late summary";
      },
    });
    cancel = () => agent.cancel();
    await expect(agent.prompt("Continue")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(0);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it("does not spend the final shared model call on a summary that cannot continue", async () => {
    const budget = {
      usage: { input: 0, output: 0, cost: 0 },
      maxCost: 1,
      modelCallsLeft: 1,
    };
    const { agent, summaries, requests } = await agentFixture({ budget });
    await expect(agent.prompt("Continue")).rejects.toThrow(/model.*budget/i);
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(budget.modelCallsLeft).toBe(1);
  });

  it("merges the previous checkpoint with only newly completed source turns", async () => {
    const { store, session, agent, summaries } = await agentFixture();
    await agent.prompt("FIRST_CURRENT");
    const first = (await store.contextHistory(session.id)).checkpoint!;
    const firstCalls = summaries.length;
    await store.append(session.id, "message", {
      message: message("assistant", "NEW_SOURCE " + "x".repeat(12000)),
    });
    await agent.prompt("SECOND_CURRENT");
    const next = (await store.contextHistory(session.id)).checkpoint!;
    expect(next.throughSeq).toBeGreaterThan(first.throughSeq);
    const source = summaries
      .slice(firstCalls)
      .flatMap((request) => request.messages.map((m) => m.text))
      .join("\n");
    expect(source).toContain("NEW_SOURCE");
    expect(source).toContain(first.summary);
    expect(source).not.toContain("ORIGINAL_SOURCE");
    expect(
      (await store.messagePage(session.id, { after: 0, limit: 10 })).items[0]!
        .message.text,
    ).toContain("ORIGINAL_SOURCE");
  });

  it("accounts summary cost and refuses activation when the shared cost limit is reached", async () => {
    const budget = {
      usage: { input: 0, output: 0, cost: 0 },
      maxCost: 0.01,
      modelCallsLeft: 10,
    };
    const { store, session, agent, summaries, requests } = await agentFixture({
      budget,
    });
    await expect(agent.prompt("Continue")).rejects.toThrow(/cost.*limit/i);
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(budget.usage.cost).toBe(0.01);
    expect(budget.modelCallsLeft).toBe(9);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it("refuses a summary after losing its execution lease", async () => {
    let expire = () => {};
    const { store, session, path, agent, requests } = await agentFixture({
      summary: () => {
        expire();
        return "Keep the source constraint";
      },
    });
    expire = () => {
      const db = new DatabaseSync(path);
      try {
        db.prepare("UPDATE leases SET expires=0 WHERE sessionId=?").run(
          session.id,
        );
      } finally {
        db.close();
      }
    };
    await expect(agent.prompt("Continue")).rejects.toThrow(/lease/i);
    expect(requests).toHaveLength(0);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it("does not summarize or truncate a current turn that cannot fit by itself", async () => {
    const { store, session, agent, summaries, requests } = await agentFixture();
    await expect(agent.prompt("CURRENT " + "x".repeat(15000))).rejects.toThrow(
      /current turn exceeds/i,
    );
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect((await store.contextHistory(session.id)).checkpoint).toBeUndefined();
  });

  it.each([false, undefined])(
    "rejects images with support %s before persisting or queuing a turn",
    async (supportsImages) => {
      const { store, session, agent, provider, summaries, requests } =
        await agentFixture();
      provider.supportsImages = supportsImages;
      const before = await store.events(session.id);
      await expect(
        agent.prompt("Inspect image", [
          { mimeType: "image/png", data: "aGVsbG8=" },
        ]),
      ).rejects.toThrow(
        supportsImages === false
          ? /does not support image/i
          : /endpoint-capabilities.*images.*true/,
      );
      expect(await store.events(session.id)).toEqual(before);
      expect(summaries).toHaveLength(0);
      expect(requests).toHaveLength(0);
      expect(agent.busy).toBe(false);
    },
  );
});
