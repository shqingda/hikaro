import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  Agent,
  ToolRegistry,
  PluginHost,
  type ProviderAdapter,
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
    await expect(agent.prompt("go")).rejects.toThrow();
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
