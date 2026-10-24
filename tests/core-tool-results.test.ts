import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  Agent,
  ToolRegistry,
  type ProviderAdapter,
  type ToolResult,
} from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

const fixtures: { store: SQLiteStore; directory: string }[] = [];
afterEach(async () => {
  for (const { store, directory } of fixtures.splice(0)) {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
const summary =
  "Cleanup failed: original process group may still be running.\n";
const evidence = {
  cleanup: "failed",
  stopError: "Permission denied",
  outputIncomplete: true,
  processNote: "Detached descendants are not stopped automatically.",
  exitCode: null,
  exitSignal: null,
  artifact: "earlier-output.log",
};
const provider: ProviderAdapter = {
  id: "test",
  model: "test",
  contextWindow: 100000,
  async *stream() {
    yield {
      type: "done",
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "result", name: "result", arguments: {} }],
        timestamp: 1,
      },
      usage: { input: 0, output: 0, cost: 0 },
    };
  },
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hikaro-tool-results-"));
  const database = join(directory, "sessions.sqlite");
  const store = await SQLiteStore.open(database);
  fixtures.push({ store, directory });
  const session = await store.createSession(directory);
  const tools = new ToolRegistry();
  const artifact = join(directory, "result.json");
  const agent = new Agent({
    session,
    store,
    tools,
    provider,
    approve: async () => false,
    saveArtifact: async (_callId, result) => {
      await writeFile(artifact, JSON.stringify(result));
      return artifact;
    },
  });
  const tool = (execute: () => Promise<ToolResult>) =>
    tools.register({
      name: "result",
      description: "Return an oversized process result",
      schema: z.object({}),
      execute,
    });
  return { agent, store, session, artifact, database, tool };
}

it.each(["manual", "model"] as const)(
  "persists a cancelled %s tool's oversized result and cleanup evidence",
  async (mode) => {
    const { agent, store, session, artifact, tool } = await fixture();
    const original = {
      text: summary + "x".repeat(61000),
      data: evidence,
      isError: true,
    };
    tool(async () => {
      agent.cancel();
      return original;
    });
    if (mode === "manual") await agent.executeTool("result", {}, "!result");
    else
      await expect(agent.prompt("Run the command")).rejects.toMatchObject({
        name: "AbortError",
      });

    const end = (await store.events(session.id)).find(
      (event) => event.type === "tool.end",
    );
    expect(end?.data).toMatchObject({
      status: "cancelled",
      result: { isError: true, data: { ...evidence, artifact } },
    });
    const message = (await store.messages(session.id)).find(
      (row) => row.role === "tool",
    );
    expect(message?.text.startsWith(summary)).toBe(true);
    expect(message?.text).toContain("Output truncated");
    expect(message?.isError).toBe(true);
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual(original);
  },
);

it.each([
  {
    name: "small object without an artifact saver",
    data: evidence,
    save: false,
    kept: true,
  },
  {
    name: "object over the UTF-8 byte limit",
    data: { detail: "中".repeat(3000) },
    save: true,
    kept: false,
  },
  { name: "array", data: [evidence], save: true, kept: false },
])("bounds retained result data: $name", async ({ data, save, kept }) => {
  const { agent, artifact, tool } = await fixture();
  if (!save) agent.options.saveArtifact = undefined;
  tool(async () => ({ text: summary + "x".repeat(61000), data }));
  const result = await agent.executeTool("result", {}, "!result");
  expect(result.data).toEqual(kept ? data : { artifact });
});

it("does not write a large-result artifact after losing its execution lease", async () => {
  const { agent, database, store, session, artifact, tool } = await fixture();
  tool(async () => {
    const db = new DatabaseSync(database);
    try {
      db.prepare("UPDATE leases SET expires=0 WHERE sessionId=?").run(
        session.id,
      );
    } finally {
      db.close();
    }
    return { text: summary + "x".repeat(61000), data: evidence };
  });
  await expect(agent.executeTool("result", {}, "!result")).rejects.toThrow(
    /lease/i,
  );
  await expect(readFile(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (await store.events(session.id)).some((event) => event.type === "tool.end"),
  ).toBe(false);
});
