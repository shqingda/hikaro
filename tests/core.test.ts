import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", { spy: true });
import { z } from "zod";
import {
  Agent,
  ToolRegistry,
  PluginHost,
  type ProviderAdapter,
  type Message,
} from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { JsonLines } from "../packages/protocol/src/index.ts";
import { codingPlugin, resolvePath } from "../packages/tools/src/index.ts";
import { codemodePlugin } from "../packages/tools/src/codemode.ts";
import { mkdtemp, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const stores: SQLiteStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture(provider: ProviderAdapter) {
  const store = await SQLiteStore.open(":memory:");
  stores.push(store);
  const cwd = await mkdtemp(join(tmpdir(), "hikaro-test-"));
  dirs.push(cwd);
  const session = await store.createSession(cwd);
  const tools = new ToolRegistry();
  const agent = new Agent({
    session,
    store,
    provider,
    tools,
    approve: async () => false,
  });
  return { agent, store, tools, session, cwd };
}
const simple: ProviderAdapter = {
  id: "test",
  model: "test",
  contextWindow: 10000,
  async *stream() {
    yield { type: "text", text: "Hello" };
    yield {
      type: "done",
      message: { role: "assistant", text: "Hello", timestamp: 1 },
      usage: { input: 1, output: 1, cost: 0 },
    };
  },
};
describe("independent agent loop", () => {
  it.each(["prompt", "compact"] as const)(
    "keeps a cancelled %s cancelled when the provider returns a final result",
    async (operation) => {
      let cancel!: () => void;
      let cancelNext = true;
      const { agent, store, session } = await fixture({
        ...simple,
        async *stream() {
          yield {
            type: "done",
            message: { role: "assistant", text: "Late result", timestamp: 1 },
            usage: { input: 1, output: 1, cost: 0 },
          };
          if (cancelNext) {
            cancelNext = false;
            cancel();
          }
        },
      });
      cancel = () => agent.cancel();
      await store.append(session.id, "message", {
        message: { role: "user", text: "Keep this goal", timestamp: 1 },
      });
      const work =
        operation === "prompt" ? agent.prompt("Task") : agent.compact();
      await expect(work).rejects.toMatchObject({ name: "AbortError" });
      expect(
        (await store.events(session.id))
          .filter((event) => event.type === "run.end")
          .map((event) => event.data.status),
      ).toEqual(["cancelled"]);
      expect(
        (await store.messages(session.id)).some(
          (message) => message.role === "assistant",
        ),
      ).toBe(false);
      await agent.prompt("Recovered");
      expect((await store.events(session.id)).at(-1)?.data.status).toBe(
        "completed",
      );
    },
  );

  it("normalizes provider cancellation errors and rejects cancelled queued prompts", async () => {
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { agent, store, session } = await fixture({
      ...simple,
      async *stream({ signal }) {
        started();
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Error("Request was aborted")),
            { once: true },
          );
        });
      },
    });
    const active = agent.prompt("Active");
    await streaming;
    const queued = agent.prompt("Queued");
    const activeCancelled = expect(active).rejects.toMatchObject({
      name: "AbortError",
    });
    const queuedCancelled = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    agent.cancel();
    await Promise.all([activeCancelled, queuedCancelled]);
    expect((await store.events(session.id)).at(-1)?.data.status).toBe(
      "cancelled",
    );
  });

  it("resumes prompts queued during a manual tool operation", async () => {
    const { agent, tools, store, session } = await fixture(simple);
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    tools.register({
      name: "manual",
      description: "Blocked manual operation",
      schema: z.object({}),
      async execute() {
        signalStarted();
        await blocked;
        return { text: "finished" };
      },
    });
    const manual = agent.executeTool("manual", {}, "!manual");
    await started;
    const queued = agent.prompt("Continue after the command");
    release();
    await manual;
    await queued;
    expect((await store.messages(session.id)).map((m) => m.text)).toEqual([
      "!manual",
      "",
      "finished",
      "Continue after the command",
      "Hello",
    ]);
  });

  it("keeps atomic tool registration unchanged on any name conflict", () => {
    const tools = new ToolRegistry();
    const tool = (name: string) => ({
      name,
      description: name,
      schema: z.object({}),
      execute: async () => ({ text: name }),
    });
    const existing = tool("existing");
    tools.register(existing);
    expect(() => tools.registerAll([tool("new"), tool("existing")])).toThrow(
      "Duplicate tool",
    );
    expect(tools.names()).toEqual(new Set(["existing"]));
    expect(tools.get("existing")).toBe(existing);
    expect(() => tools.registerAll([tool("new"), tool("new")])).toThrow(
      "Duplicate tool",
    );
    expect(tools.names()).toEqual(new Set(["existing"]));
    tools.registerAll([tool("first"), tool("second")]);
    expect(tools.names()).toEqual(new Set(["existing", "first", "second"]));
  });

  it("persists ordered events and messages", async () => {
    const { agent, store, session } = await fixture(simple);
    await agent.prompt("Hi");
    const events = await store.events(session.id);
    expect(events.map((e) => e.seq)).toEqual(
      [...events].map((e) => e.seq).sort((a, b) => a - b),
    );
    expect(events.at(-1)?.data.status).toBe("completed");
    expect((await store.messages(session.id)).map((m) => m.text)).toEqual([
      "Hi",
      "Hello",
    ]);
  });
  it("validates tool parameters before running side effects", async () => {
    const { agent, tools } = await fixture(simple);
    let calls = 0;
    tools.register({
      name: "write",
      description: "test",
      schema: z.object({ value: z.number() }),
      async execute() {
        calls++;
        return { text: "ok" };
      },
    });
    expect(
      (
        await agent.invoke(
          "write",
          { value: "wrong" },
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(calls).toBe(0);
  });
  it("executes tool calls and returns their results to the provider", async () => {
    let turns = 0;
    const provider: ProviderAdapter = {
      ...simple,
      async *stream(input) {
        turns++;
        if (turns === 1)
          yield {
            type: "done",
            message: {
              role: "assistant",
              text: "",
              toolCalls: [
                { id: "one", name: "sum", arguments: { a: 2, b: 3 } },
              ],
              timestamp: 1,
            },
            usage: { input: 1, output: 1, cost: 0 },
          };
        else {
          expect(input.messages.at(-1)?.text).toBe("5");
          yield* simple.stream(input);
        }
      },
    };
    const { agent, tools } = await fixture(provider);
    tools.register({
      name: "sum",
      description: "sum",
      schema: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }) {
        return { text: String(a + b) };
      },
    });
    await agent.prompt("add");
    expect(turns).toBe(2);
  });
  it("records cancellation and does not execute remaining tools", async () => {
    const { agent, tools, store, session } = await fixture({
      ...simple,
      async *stream() {
        yield {
          type: "done",
          message: {
            role: "assistant",
            text: "",
            toolCalls: [
              { id: "a", name: "stop", arguments: {} },
              { id: "b", name: "never", arguments: {} },
            ],
            timestamp: 1,
          },
          usage: { input: 0, output: 0, cost: 0 },
        };
      },
    });
    let ran = false;
    tools.register({
      name: "stop",
      description: "stop",
      schema: z.object({}),
      async execute() {
        agent.cancel();
        return { text: "stopped" };
      },
    });
    tools.register({
      name: "never",
      description: "never",
      schema: z.object({}),
      async execute() {
        ran = true;
        return { text: "" };
      },
    });
    await expect(agent.prompt("go")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(ran).toBe(false);
    expect((await store.events(session.id)).at(-1)?.data.status).toBe(
      "cancelled",
    );
  });
  it("deduplicates persisted command IDs", async () => {
    const { store, session } = await fixture(simple);
    expect(await store.claim("same", session.id)).toBe(true);
    expect(await store.claim("same", session.id)).toBe(false);
  });
  it("denies external symlink reads and untrusted writes", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    const outside = await mkdtemp(join(tmpdir(), "hikaro-outside-"));
    dirs.push(outside);
    await writeFile(join(outside, "secret"), "secret");
    await symlink(outside, join(cwd, "link"));
    await new PluginHost(tools).load(codingPlugin({ trusted: false }));
    expect((await resolvePath(cwd, "link/secret")).inside).toBe(false);
    expect(
      (
        await agent.invoke(
          "read_file",
          { path: "link/secret" },
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: "new", content: "x" },
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
  });
  it("prevents edits when expected text is ambiguous", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    await writeFile(join(cwd, "a"), "same same");
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    const result = await agent.invoke(
      "edit_file",
      { path: "a", oldText: "same", newText: "other" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("same same");
  });
  it("rejects overlapping edit matches without changing the file", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    await writeFile(join(cwd, "a"), "aaa");
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    const result = await agent.invoke(
      "edit_file",
      { path: "a", oldText: "aa", newText: "X" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("aaa");
  });
  it("preserves concurrent edits across plugin instances and symlink aliases", async () => {
    const { agent, tools, cwd, session, store } = await fixture(simple);
    const otherTools = new ToolRegistry();
    const other = new Agent({
      session,
      store,
      provider: simple,
      tools: otherTools,
      approve: async () => false,
    });
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    await new PluginHost(otherTools).load(codingPlugin({ trusted: true }));
    const words = Array.from({ length: 12 }, (_, i) => `word_${i};`);
    await writeFile(join(cwd, "a"), words.join(" "));
    await symlink(join(cwd, "a"), join(cwd, "alias"));
    const results = await Promise.all(
      words.map((word, i) =>
        (i % 2 ? other : agent).invoke(
          "edit_file",
          {
            path: i % 2 ? "alias" : "a",
            oldText: word,
            newText: word.toUpperCase(),
          },
          new AbortController().signal,
        ),
      ),
    );
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(await readFile(join(cwd, "a"), "utf8")).toBe(
      words.join(" ").toUpperCase(),
    );
  });
  it("rejects stale concurrent replacements instead of reporting two successful writes", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    await writeFile(join(cwd, "a"), "original");
    const results = await Promise.all(
      ["first", "second"].map((content) =>
        agent.invoke(
          "write_file",
          { path: "a", content, expected: "original" },
          new AbortController().signal,
        ),
      ),
    );
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.find((result) => result.isError)?.text).toMatch(/changed/i);
    expect(["first", "second"]).toContain(
      await readFile(join(cwd, "a"), "utf8"),
    );
  });
  it("rejects a file version changed by an external writer before saving", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    const path = join(cwd, "a");
    await writeFile(path, "original");
    const { stat: originalStat } =
      await vi.importActual<typeof fs>("node:fs/promises");
    let changed = false;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const info = await originalStat(...args);
      if (!changed && String(args[0]).endsWith("/a")) {
        changed = true;
        await writeFile(path, "external update");
      }
      return info;
    });
    try {
      const result = await agent.invoke(
        "edit_file",
        { path: "a", oldText: "external", newText: "agent" },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/changed during editing/);
      expect(await readFile(path, "utf8")).toBe("external update");
    } finally {
      spy.mockRestore();
    }
  });
  it("releases the file queue after a failed edit", async () => {
    const { agent, tools, cwd } = await fixture(simple);
    await new PluginHost(tools).load(codingPlugin({ trusted: true }));
    await writeFile(join(cwd, "a"), "original");
    const failed = await agent.invoke(
      "edit_file",
      { path: "a", oldText: "missing", newText: "bad" },
      new AbortController().signal,
    );
    expect(failed.isError).toBe(true);
    const next = await agent.invoke(
      "edit_file",
      { path: "a", oldText: "original", newText: "updated" },
      new AbortController().signal,
    );
    expect(next.isError).not.toBe(true);
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("updated");
  });
  it("retains complete model history beyond 1000 messages", async () => {
    let received: Message[] = [];
    const { agent, store, session } = await fixture({
      ...simple,
      contextWindow: 1_000_000,
      async *stream(input) {
        received = input.messages;
        yield* simple.stream(input);
      },
    });
    await store.append(session.id, "message", {
      message: {
        role: "user",
        text: "Keep the original constraint",
        timestamp: 1,
      },
    });
    for (let i = 0; i < 501; i++) {
      await store.append(session.id, "message", {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: String(i), name: "inspect", arguments: {} }],
          timestamp: 1,
        },
      });
      await store.append(session.id, "message", {
        message: {
          role: "tool",
          text: "ok",
          name: "inspect",
          callId: String(i),
          timestamp: 1,
        },
      });
    }
    await agent.prompt("Continue");
    expect(received[0]?.text).toBe("Keep the original constraint");
    expect(received).toHaveLength(1004);
    expect(received.filter((message) => message.role === "tool")).toHaveLength(
      501,
    );
  });
  it.each([
    {
      contextWindow: 20_000_000,
      omitted: 3,
      firstRetained: "Recent whole turn",
    },
    { contextWindow: 10000, omitted: 5, firstRetained: "Continue" },
  ])(
    "reports history omitted by the storage capacity and keeps whole turns ($contextWindow)",
    async ({ contextWindow, omitted, firstRetained }) => {
      let received: Message[] = [];
      const { agent, store, session } = await fixture({
        ...simple,
        contextWindow,
        async *stream(input) {
          received = input.messages;
          yield* simple.stream(input);
        },
      });
      const message = (role: Message["role"], text: string): Message => ({
        role,
        text,
        timestamp: 1,
      });
      await store.append(session.id, "message", {
        message: message("user", "Old constraint"),
      });
      await store.append(session.id, "message", {
        message: {
          ...message("assistant", "x".repeat(5 * 1024 * 1024)),
          toolCalls: [{ id: "old", name: "inspect", arguments: {} }],
        },
      });
      await store.append(session.id, "message", {
        message: {
          ...message("tool", "Older tool result"),
          callId: "old",
          name: "inspect",
        },
      });
      await store.append(session.id, "message", {
        message: message("user", "Recent whole turn"),
      });
      await store.append(session.id, "message", {
        message: message("assistant", "y".repeat(5 * 1024 * 1024)),
      });
      const windowed: Record<string, unknown>[] = [];
      agent.subscribe((event) => {
        if (event.type === "context.windowed") windowed.push(event.data);
      });
      await agent.prompt("Continue");
      expect(windowed).toEqual([expect.objectContaining({ omitted })]);
      expect(received[0]?.text).toMatch(/Earlier conversation omitted/);
      expect(received[1]?.text).toBe(firstRetained);
      expect(received.at(-1)?.text).toBe("Continue");
      expect(received.some((message) => message.role === "tool")).toBe(false);
    },
  );
  it("rejects an oversized current turn instead of sending partial tool history", async () => {
    let called = false;
    const { agent, store, session } = await fixture({
      ...simple,
      async *stream(input) {
        called = true;
        yield* simple.stream(input);
      },
    });
    await store.append(session.id, "message", {
      message: { role: "user", text: "Original goal", timestamp: 1 },
    });
    await store.append(session.id, "message", {
      message: {
        role: "assistant",
        text: "x".repeat(8 * 1024 * 1024),
        timestamp: 1,
      },
    });
    await expect(agent.prompt("Continue")).rejects.toThrow(/history capacity/);
    expect(called).toBe(false);
  });
  it("isolates codemode and routes calls through the tool broker", async () => {
    const { agent, tools } = await fixture(simple);
    tools.register({
      name: "echo",
      description: "echo",
      schema: z.object({ value: z.number() }),
      async execute({ value }) {
        return { text: String(value) };
      },
    });
    await new PluginHost(tools).load(codemodePlugin());
    const result = await agent.invoke(
      "codemode",
      {
        code: "print(typeof process); const result = await tools.echo({value: 7}); print(result.text);",
      },
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("undefined");
    expect(result.text).toContain("7");
  });
});
describe("JSONL framing", () => {
  it("preserves split UTF-8 and Unicode separators", () => {
    const found: unknown[] = [];
    const parser = new JsonLines((x) => found.push(x));
    const b = Buffer.from(JSON.stringify({ text: "你好\u2028yes" }) + "\r\n");
    for (const byte of b) parser.push(Uint8Array.of(byte));
    expect(found).toEqual([{ text: "你好\u2028yes" }]);
  });
  it("rejects oversized unterminated frames", () => {
    const parser = new JsonLines(() => {}, 4);
    expect(() => parser.push(Buffer.from("12345"))).toThrow("too large");
  });
});

describe("worker isolation and recovery boundaries", () => {
  it("keeps the host responsive while interrupting a CPU-bound codemode script", async () => {
    const { agent, tools } = await fixture(simple);
    await new PluginHost(tools).load(codemodePlugin({ timeoutMs: 5000 }));
    const abort = new AbortController();
    let heartbeat = false;
    const timer = setTimeout(() => {
      heartbeat = true;
      abort.abort();
    }, 50);
    const start = performance.now();
    const result = await agent.invoke(
      "codemode",
      { code: "while(true) {}" },
      abort.signal,
    );
    clearTimeout(timer);
    expect(heartbeat).toBe(true);
    expect(result.isError).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it("paginates whole messages and strips provider payloads from UI pages", async () => {
    const { store, session } = await fixture(simple);
    for (let i = 0; i < 45; i++)
      await store.append(session.id, "message", {
        message: {
          role: "user",
          text: String(i),
          timestamp: i,
          providerData: { internal: true },
        },
      });
    const last = await store.messagePage(session.id, { limit: 20 });
    expect(last.items).toHaveLength(20);
    expect(last.items[0]?.message.text).toBe("25");
    expect(last.hasOlder).toBe(true);
    expect(last.hasNewer).toBe(false);
    expect(last.items[0]?.message.providerData).toBeUndefined();
    const previous = await store.messagePage(session.id, {
      before: last.items[0]!.seq,
      limit: 20,
    });
    expect(previous.items[0]?.message.text).toBe("5");
    expect(previous.hasNewer).toBe(true);
  });
  it("only claims jobs belonging to the active workspace", async () => {
    const { store, session } = await fixture(simple);
    await store.putJob({
      id: "job1",
      sessionId: session.id,
      task: "test",
      runAt: 0,
      state: "queued",
    });
    expect(await store.claimJob("worker", "/different")).toBeUndefined();
    expect((await store.claimJob("worker", session.cwd))?.id).toBe("job1");
    expect(await store.claimJob("other", session.cwd)).toBeUndefined();
    await store.finishJob("job1", "worker", "completed");
    expect((await store.jobs())[0]?.state).toBe("completed");
  });
  it("rolls back registrations when a plugin fails during setup", async () => {
    const { tools } = await fixture(simple);
    const host = new PluginHost(tools);
    await expect(
      host.load({
        id: "broken",
        apiVersion: 1,
        setup(plugin) {
          plugin.registerTool({
            name: "partial",
            description: "partial",
            schema: z.object({}),
            async execute() {
              return { text: "" };
            },
          });
          throw Error("setup failed");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(tools.get("partial")).toBeUndefined();
  });
});
