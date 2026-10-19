import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fitContext, summarizeHistory } from "../packages/core/src/context.ts";
import {
  Agent,
  ToolRegistry,
  type Message,
  type ProviderAdapter,
} from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { Runtime } from "../packages/runtime/src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const message = (role: Message["role"], text: string): Message => ({
  role,
  text,
  timestamp: 1,
});
const stores: SQLiteStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("complete request context budget", () => {
  it("allows only one concurrent agent to spend the last shared model call", async () => {
    const store = await SQLiteStore.open(":memory:");
    stores.push(store);
    const history = store.contextHistory.bind(store);
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.contextHistory = async (id) => {
      const result = await history(id);
      if (result.messages.length) {
        if (++arrived === 2) release();
        await ready;
      }
      return result;
    };
    let calls = 0;
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 16000,
      async *stream() {
        calls++;
        yield {
          type: "done",
          message: message("assistant", "Finished"),
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    };
    const budget = {
      usage: { input: 0, output: 0, cost: 0 },
      maxCost: 10,
      modelCallsLeft: 1,
    };
    const agents = await Promise.all(
      [1, 2].map(
        async () =>
          new Agent({
            store,
            session: await store.createSession(process.cwd()),
            provider,
            tools: new ToolRegistry(),
            budget,
            approve: async () => false,
          }),
      ),
    );
    const outcomes = await Promise.allSettled(
      agents.map((agent) => agent.prompt("Continue")),
    );
    expect(calls).toBe(1);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(budget.modelCallsLeft).toBe(0);
  });

  it("runs a normal 32K session with the complete built-in registry and skill metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hikaro-context-runtime-"));
    let runtime: Runtime | undefined;
    try {
      runtime = await Runtime.open({
        cwd,
        home: join(cwd, "home"),
        demo: true,
        approve: async () => false,
      });
      const agent = await runtime.agent(await runtime.session());
      // Keep the test independent of the user's personal skill catalog while
      // representing its real size. Use the actual complete Runtime registry.
      agent.options.system =
        "You are Hikaro. Inspect before editing.\nAvailable skills:\n" +
        Array.from(
          { length: 50 },
          (_, i) =>
            `Skill ${i}: ${"Build reliable applications with focused tests and clear constraints. ".repeat(4)}\n`,
        ).join("");
      await agent.prompt("继续处理项目");
      expect(
        (await runtime.store.messages(agent.options.session.id)).at(-1)?.role,
      ).toBe("assistant");
    } finally {
      await runtime?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["system", "tools"] as const)(
    "rejects an oversized %s even when the current prompt is short",
    (component) => {
      const context = fitContext([message("user", "Continue")], 4096, {
        system: component === "system" ? "x".repeat(15000) : "",
        tools:
          component === "tools"
            ? [
                {
                  name: "inspect",
                  description: "x".repeat(15000),
                  parameters: {},
                },
              ]
            : [],
      });
      expect(context.overflow).toBe(true);
      expect(context.estimate.inputTokens).toBeGreaterThan(context.budget);
    },
  );

  it("reserves output and removes a complete older tool turn", () => {
    const history: Message[] = [
      message("user", "Earlier constraint " + "x".repeat(5400)),
      {
        ...message("assistant", ""),
        toolCalls: [
          { id: "read-1", name: "read_file", arguments: { path: "src/a.ts" } },
        ],
      },
      { ...message("tool", "source"), callId: "read-1", name: "read_file" },
      message("user", "Current goal"),
    ];
    const context = fitContext(history, 4096, { outputTokens: 2500 });
    expect(context.removed).toEqual(history.slice(0, 3));
    expect(context.messages.at(-1)).toBe(history[3]);
    expect(context.messages[0]?.text).toContain("Earlier conversation omitted");
    expect(context.estimate.outputTokens).toBe(2500);
    expect(context.estimate.inputTokens).toBeLessThanOrEqual(context.budget);
    expect(history).toHaveLength(4);
  });

  it("includes storage omission feedback in the same request budget", () => {
    const context = fitContext([message("user", "x".repeat(300))], 4096, {
      outputTokens: 3800,
      omitted: 20,
    });
    expect(context.omitted).toBe(20);
    expect(context.estimate.noticeTokens).toBeGreaterThan(0);
    expect(context.overflow).toBe(true);
  });

  it("budgets images independently of their base64 transport size", () => {
    const fit = (data: string) =>
      fitContext(
        [
          {
            ...message("user", "Inspect"),
            images: [{ mimeType: "image/png", data }],
          },
        ],
        16000,
      );
    expect(fit("a").estimate).toEqual(fit("a".repeat(100_000)).estimate);
    expect(fit("a").estimate.imageTokens).toBe(8192);
  });

  it("never discards part of the latest tool turn to make it fit", () => {
    const history: Message[] = [
      message("user", "Keep this constraint"),
      {
        ...message("assistant", ""),
        toolCalls: [{ id: "read-1", name: "read_file", arguments: {} }],
      },
      {
        ...message("tool", "x".repeat(15000)),
        callId: "read-1",
        name: "read_file",
      },
    ];
    const context = fitContext(history, 4096);
    expect(context.messages).toEqual(history);
    expect(context.removed).toEqual([]);
    expect(context.overflow).toBe(true);
  });

  it.each(["system", "tools", "output"] as const)(
    "does not dispatch or spend a model call when %s exhausts the budget",
    async (component) => {
      let calls = 0;
      const provider: ProviderAdapter = {
        id: "fixture",
        model: "fixture",
        contextWindow: 4096,
        maxOutputTokens: component === "output" ? 3900 : 1024,
        async *stream() {
          calls++;
          yield {
            type: "done",
            message: message("assistant", "Unexpected dispatch"),
            usage: { input: 1, output: 1, cost: 0 },
          };
        },
      };
      const store = await SQLiteStore.open(":memory:");
      stores.push(store);
      const session = await store.createSession(process.cwd());
      const tools = new ToolRegistry();
      if (component === "tools")
        tools.register({
          name: "inspect",
          description: "x".repeat(15000),
          schema: z.object({}),
          execute: async () => ({ text: "ok" }),
        });
      const agent = new Agent({
        store,
        session,
        tools,
        provider,
        system: component === "system" ? "x".repeat(15000) : "Act carefully.",
        approve: async () => false,
      });
      const callsBefore = agent.budget.modelCallsLeft;
      await expect(agent.prompt("Continue")).rejects.toThrow(/context budget/i);
      expect(calls).toBe(0);
      expect(agent.budget.modelCallsLeft).toBe(callsBefore);
      expect((await store.events(session.id)).at(-1)?.data.status).toBe(
        "failed",
      );
    },
  );
});

describe("continuation source preservation", () => {
  it("keeps a source record whole when it fits in a fresh summary request", async () => {
    const sources: string[] = [];
    const path = "src/" + "folder/".repeat(110) + "contract.ts";
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 4000,
      async *stream(input) {
        sources.push(input.messages[0]!.text);
        yield {
          type: "done",
          message: message("assistant", "Carry state"),
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    };
    const rows = [
      { seq: 1, message: message("user", "x".repeat(1500)) },
      {
        seq: 2,
        message: {
          ...message("assistant", ""),
          toolCalls: [{ id: "read", name: "read_file", arguments: { path } }],
        },
      },
    ];
    await summarizeHistory(
      provider,
      async (after) => rows.filter((row) => row.seq > after),
      new AbortController().signal,
    );
    expect(sources.some((source) => source.includes(path))).toBe(true);
  });

  it("bounds multilingual summary requests including the previous summary and output", async () => {
    const received: string[] = [];
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 4000,
      maxOutputTokens: 1400,
      async *stream(input) {
        const context = fitContext(input.messages, this.contextWindow, {
          system: input.system,
          tools: input.tools,
          outputTokens: this.maxOutputTokens,
        });
        expect(context.overflow).toBe(false);
        expect(input.messages[0]!.text).not.toContain("\ufffd");
        received.push(input.messages[0]!.text);
        yield {
          type: "done",
          message: message("assistant", "保留约束。".repeat(15)),
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    };
    const rows = [
      {
        seq: 1,
        message: message("user", "开始" + '约束😀\\"'.repeat(1000) + "结束"),
      },
    ];
    await summarizeHistory(
      provider,
      async (after) => rows.filter((row) => row.seq > after),
      new AbortController().signal,
    );
    expect(received.length).toBeGreaterThan(1);
    expect(received.join("")).toContain("开始");
    expect(received.at(-1)).toContain("结束");
  });

  it("rejects an oversized summary before carrying it into another request", async () => {
    let calls = 0;
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 4000,
      async *stream() {
        calls++;
        yield {
          type: "done",
          message: message("assistant", "约".repeat(1000)),
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    };
    await expect(
      summarizeHistory(
        provider,
        async (after) =>
          after ? [] : [{ seq: 1, message: message("user", "x".repeat(8000)) }],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Summary exceeded its budget/);
    expect(calls).toBe(1);
  });

  it("includes tool arguments, call identifiers and source sequences in summary input", async () => {
    let source = "";
    const provider: ProviderAdapter = {
      id: "fixture",
      model: "fixture",
      contextWindow: 16000,
      async *stream(input) {
        source += input.messages[0]!.text;
        yield {
          type: "done",
          message: message("assistant", "Preserved constraints and paths."),
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    };
    const rows = [
      { seq: 10, message: message("user", "Preserve the public interface") },
      {
        seq: 12,
        message: {
          ...message("assistant", ""),
          toolCalls: [
            {
              id: "read-a",
              name: "read_file",
              arguments: { path: "src/contract.ts" },
            },
          ],
        },
      },
      {
        seq: 15,
        message: {
          ...message("tool", "export interface Contract {}"),
          callId: "read-a",
          name: "read_file",
        },
      },
    ];
    await summarizeHistory(
      provider,
      async (after) => rows.filter((row) => row.seq > after),
      new AbortController().signal,
    );
    expect(source).toContain("src/contract.ts");
    expect(source).toContain("read-a");
    expect(source).toContain("12");
    expect(source).toContain("Preserve the public interface");
  });
});
