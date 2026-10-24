import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { executionHistory } from "../packages/runtime/src/execution-history.ts";

it("reads persisted run outcomes without treating a missing end as completion", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-run-history-"));
  let store = await SQLiteStore.open(join(home, "db.sqlite"));
  try {
    const session = await store.createSession(home),
      other = await store.createSession(home);
    await store.append(session.id, "run.start", {
      runId: "failed-run",
      provider: "test",
      model: "fixture",
    });
    await store.append(session.id, "run.end", {
      runId: "failed-run",
      status: "failed",
      error: "fixture error",
      usage: { input: 3, output: 1, cost: 0 },
    });
    await store.append(session.id, "run.start", { runId: "unfinished-run" });
    await store.append(other.id, "run.end", {
      runId: "foreign-run",
      status: "completed",
    });
    await store.close();
    store = await SQLiteStore.open(join(home, "db.sqlite"));
    const items = await executionHistory(store, session.id);
    expect(items.map((q) => [q.id, q.state])).toEqual([
      ["unfinished-run", "unknown · no recorded end"],
      ["failed-run", "failed"],
    ]);
    expect(items[1]!.detail).toContain("fixture error");
    expect(items[1]!.detail).toContain("test/fixture");
    expect(items.every((q) => q.actions.length === 0)).toBe(true);
    expect(await executionHistory(store, other.id)).toHaveLength(1);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("bounds reads to 200 events and 100 runs with newest outcomes first", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession(process.cwd());
    for (let n = 0; n < 105; n++) {
      await store.append(session.id, "run.start", { runId: `run-${n}` });
      await store.append(session.id, "run.end", {
        runId: `run-${n}`,
        status: n === 104 ? "cancelled" : "completed",
      });
    }
    expect(await store.recentRunEvents(session.id)).toHaveLength(200);
    const items = await executionHistory(store, session.id);
    expect(items).toHaveLength(100);
    expect(items[0]!.id).toBe("run-104");
    expect(items[0]!.state).toBe("cancelled");
    expect(items.at(-1)!.id).toBe("run-5");
  } finally {
    await store.close();
  }
});
