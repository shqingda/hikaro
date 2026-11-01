import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  ContextUsageBlock,
  formatTokens,
  type ContextUsage,
} from "../packages/tui/src/context-usage.ts";
import { setColorScheme } from "../packages/tui/src/theme.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => {
  vi.unstubAllEnvs();
  setColorScheme(false);
});

it("estimates context usage by category without calling the model", async () => {
  const store = await SQLiteStore.open(":memory:");
  const tools = new ToolRegistry();
  tools.register({
    name: "read",
    description: "Read a file",
    schema: z.object({ path: z.string() }),
    async execute() {
      return { text: "" };
    },
  });
  let calls = 0;
  const agent = new Agent({
    session: await store.createSession(process.cwd()),
    store,
    tools,
    approve: async () => true,
    provider: {
      id: "test",
      model: "small",
      contextWindow: 256000,
      maxOutputTokens: 8000,
      async *stream() {
        calls++;
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, text: "ok", timestamp: 1 },
          usage: { input: 1, output: 1, cost: 0 },
        };
      },
    },
  });
  try {
    const empty = await agent.contextUsage();
    expect(empty.messageCount).toBe(0);
    await agent.prompt("hello there");
    expect(calls).toBe(1);
    const usage = await agent.contextUsage();
    expect(calls).toBe(1);
    expect(usage).toMatchObject({
      provider: "test",
      model: "small",
      contextWindow: 256000,
      toolCount: 1,
      messageCount: 2,
      outputReserve: 8000,
      compacted: false,
      omitted: 0,
    });
    expect(usage.system).toBeGreaterThan(0);
    expect(usage.tools).toBeGreaterThan(0);
    expect(usage.messages).toBeGreaterThan(empty.messages);
    expect(usage.used).toBe(
      usage.system + usage.tools + usage.messages + usage.images,
    );
    expect(usage.compactAt).toBe(Math.floor(usage.budget * 0.85));
  } finally {
    await store.close();
  }
});

const usage: ContextUsage = {
  provider: "xai",
  model: "grok-4.7",
  contextWindow: 256000,
  used: 18234,
  system: 1200,
  tools: 3400,
  toolCount: 25,
  messages: 13634,
  images: 0,
  messageCount: 42,
  outputReserve: 16384,
  safety: 12800,
  budget: 226816,
  compactAt: 192793,
  compacted: false,
  omitted: 0,
};

it("formats token counts like Grok Build", () => {
  expect(formatTokens(256000)).toBe("256K");
  expect(formatTokens(1000000)).toBe("1M");
  expect(formatTokens(18234)).toBe("18.2K");
  expect(formatTokens(512)).toBe("512");
});

it("renders used / window, a 100-cell bar and a legend", () => {
  const lines = new ContextUsageBlock(usage).render(80).map(strip);
  expect(lines).toContain(" 18.2K / 256K tokens (7.12%)");
  expect(lines).toContain(" xai/grok-4.7");
  const bar = lines.filter((line) => /^ [◆◈◊◇]( [◆◈◊◇])*$/.test(line));
  expect(bar).toHaveLength(5);
  expect(bar.join(" ").match(/[◆◈◊◇]/g)).toHaveLength(100);
  expect(
    lines.some((l) => l.includes("Tool definitions") && l.includes("25 tools")),
  ).toBe(true);
  expect(
    lines.some((l) => l.includes("Messages") && l.includes("42 messages")),
  ).toBe(true);
  expect(lines.some((l) => l.startsWith(" ◇ Free"))).toBe(true);
  expect(lines.some((l) => l.includes("Auto-compact at 193K"))).toBe(true);
  for (const line of new ContextUsageBlock(usage).render(80))
    expect(strip(line).length).toBeLessThanOrEqual(80);
});

it("stacks the bar and legend on narrow terminals", () => {
  const lines = new ContextUsageBlock(usage).render(40).map(strip);
  expect(lines.filter((line) => /^ [◆◈◊◇]( [◆◈◊◇])*$/.test(line))).toHaveLength(
    10,
  );
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
});

it("repaints with the scheme and drops color under NO_COLOR", () => {
  const block = new ContextUsageBlock(usage);
  const dark = block.render(80).join("\n");
  setColorScheme(true);
  expect(block.render(80).join("\n")).not.toBe(dark);
  vi.stubEnv("NO_COLOR", "1");
  expect(block.render(80).join("\n")).not.toContain("\x1b[");
});

it("warns when the next request will be summarized", () => {
  const full = { ...usage, used: 200000, messages: 195400 };
  expect(new ContextUsageBlock(full).render(80).map(strip)).toContain(
    " Earlier history is summarized before the next request",
  );
});
