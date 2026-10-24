import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  Agent,
  ToolRegistry,
  type ProviderAdapter,
} from "../packages/core/src/index.ts";

it("shows coalesced text while the provider stream pauses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hikaro-coalesce-"));
  const store = await SQLiteStore.open(join(dir, "sessions.sqlite"));
  let resume!: () => void;
  const paused = new Promise<void>((done) => (resume = done));
  const provider: ProviderAdapter = {
    id: "test",
    model: "test",
    contextWindow: 10000,
    async *stream() {
      yield { type: "text", text: "first " };
      // Within the 24 ms coalescing window, then the model goes quiet.
      yield { type: "text", text: "second" };
      await paused;
      yield {
        type: "done",
        message: { role: "assistant", text: "first second", timestamp: 1 },
        usage: { input: 1, output: 1, cost: 0 },
      };
    },
  };
  try {
    const session = await store.createSession(dir);
    const agent = new Agent({
      session,
      store,
      tools: new ToolRegistry(),
      provider,
      approve: async () => true,
    });
    let shown = "";
    agent.subscribe((event) => {
      if (event.type === "text.delta") shown += String(event.data.text);
    });
    const run = agent.prompt("Task");
    const deadline = Date.now() + 1000;
    while (!shown.includes("second") && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 10));
    expect(shown).toBe("first second");
    resume();
    await run;
    expect(shown).toBe("first second");
  } finally {
    resume();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
