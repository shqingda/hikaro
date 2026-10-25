import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  Agent,
  ToolRegistry,
  type ProviderAdapter,
} from "../packages/core/src/index.ts";

it("shows coalesced text within 12 ms while the provider stream pauses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hikaro-coalesce-"));
  const store = await SQLiteStore.open(join(dir, "sessions.sqlite"));
  let resume!: () => void;
  const paused = new Promise<void>((done) => (resume = done));
  let notifyPaused!: () => void;
  const providerPaused = new Promise<void>((done) => (notifyPaused = done));
  let run: Promise<void> | undefined;
  const provider: ProviderAdapter = {
    id: "test",
    model: "test",
    contextWindow: 10000,
    async *stream() {
      yield { type: "text", text: "first " };
      // Both chunks arrive together, then the model goes quiet.
      yield { type: "text", text: "second" };
      notifyPaused();
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    run = agent.prompt("Task");
    await providerPaused;
    await vi.advanceTimersByTimeAsync(12);
    // Wait for the SQLite worker to publish the queued delta.
    await store.events(session.id);
    expect(shown).toBe("first second");
    resume();
    await run;
    expect(shown).toBe("first second");
  } finally {
    resume();
    await run;
    vi.useRealTimers();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
