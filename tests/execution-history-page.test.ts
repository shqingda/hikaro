import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import * as history from "../packages/runtime/src/execution-history.ts";

it("pages every retained run beyond the old limit and reads old details after reopening storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-run-pages-"));
  const path = join(home, "sessions.sqlite");
  let store = await SQLiteStore.open(path);
  try {
    const session = await store.createSession(home);
    for (let n = 0; n < 225; n++) {
      await store.append(session.id, "run.start", {
        runId: `run-${n}`,
        provider: "fixture",
        model: `model-${n}`,
      });
      await store.append(session.id, "run.end", {
        runId: `run-${n}`,
        status: "completed",
      });
    }
    await store.close();
    store = await SQLiteStore.open(path);
    const ids: string[] = [];
    let cursor: { snapshot?: number; before?: number } = {};
    for (;;) {
      const page = await history.executionHistoryPage(
        store,
        session.id,
        cursor,
      );
      expect(page.items.length).toBeLessThanOrEqual(20);
      expect(
        page.items.every(
          (item) => item.actions.length === 0 && item.detail === "",
        ),
      ).toBe(true);
      if (cursor.snapshot !== undefined)
        expect(page.snapshot).toBe(cursor.snapshot);
      ids.push(...page.items.map((item) => item.id));
      if (page.nextBefore === null) break;
      expect(page.nextBefore).toBeLessThan(cursor.before ?? page.snapshot + 1);
      cursor = { snapshot: page.snapshot, before: page.nextBefore };
    }
    expect(ids).toEqual(
      Array.from({ length: 225 }, (_, n) => `run-${224 - n}`),
    );
    const detail = await history.executionHistoryDetail(
      store,
      session.id,
      "run-0",
    );
    expect(detail.state).toBe("completed");
    expect(detail.detail).toContain("fixture/model-0");
    expect(detail.detail).not.toContain("recent event window");
    expect(detail.actions).toEqual([]);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("pairs starts outside the scan window and keeps late end events outside a fixed snapshot", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession("/fixture");
    await store.append(session.id, "run.start", {
      runId: "long-run",
      provider: "old",
      model: "original",
    });
    await store.append(session.id, "run.start", { runId: "unfinished" });
    for (let n = 0; n < 230; n++)
      await store.append(session.id, "run.start", { runId: `filler-${n}` });
    await store.append(session.id, "run.end", {
      runId: "long-run",
      status: "failed",
      error: "late failure",
    });
    const first = await history.executionHistoryPage(store, session.id);
    expect(first.items[0]).toMatchObject({ id: "long-run", state: "failed" });
    expect(
      (
        await history.executionHistoryDetail(
          store,
          session.id,
          "long-run",
          first.snapshot,
        )
      ).detail,
    ).toContain("old/original");
    await store.append(session.id, "run.end", {
      runId: "unfinished",
      status: "completed",
    });
    await store.append(session.id, "run.start", { runId: "later-run" });
    const ids = first.items.map((item) => item.id);
    let next = first.nextBefore;
    while (next !== null) {
      const page = await history.executionHistoryPage(store, session.id, {
        snapshot: first.snapshot,
        before: next,
      });
      ids.push(...page.items.map((item) => item.id));
      next = page.nextBefore;
    }
    expect(ids).toHaveLength(232);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("later-run");
    expect(
      (
        await history.executionHistoryDetail(
          store,
          session.id,
          "unfinished",
          first.snapshot,
        )
      ).state,
    ).toBe("unknown · no recorded end");
    expect(
      (await history.executionHistoryDetail(store, session.id, "unfinished"))
        .state,
    ).toBe("completed");
  } finally {
    await store.close();
  }
});

it("advances through empty pages caused by duplicate run events without losing old anchors", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession("/fixture");
    await store.append(session.id, "run.start", { runId: "oldest" });
    for (let n = 0; n < 650; n++)
      await store.append(session.id, "run.end", {
        runId: "duplicate",
        status: "cancelled",
      });
    const first = await history.executionHistoryPage(store, session.id);
    expect(first.items.map((item) => item.id)).toEqual(["duplicate"]);
    expect(first.snapshot - first.nextBefore!).toBe(199);
    const empty = await history.executionHistoryPage(store, session.id, {
      snapshot: first.snapshot,
      before: first.nextBefore!,
    });
    expect(empty.items).toEqual([]);
    expect(empty.nextBefore).not.toBeNull();
    expect(first.nextBefore! - empty.nextBefore!).toBe(200);
    const ids = first.items.map((item) => item.id);
    let next = empty.nextBefore;
    while (next !== null) {
      const page = await history.executionHistoryPage(store, session.id, {
        snapshot: first.snapshot,
        before: next,
      });
      ids.push(...page.items.map((item) => item.id));
      next = page.nextBefore;
    }
    expect(ids).toEqual(["duplicate", "oldest"]);
  } finally {
    await store.close();
  }
});

it("isolates sessions, bounds malformed cursors and preserves unknown terminal state", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession("/fixture"),
      other = await store.createSession("/fixture");
    expect(await history.executionHistoryPage(store, session.id)).toEqual({
      items: [],
      snapshot: 0,
      nextBefore: null,
    });
    await store.append(session.id, "run.end", {
      runId: "orphan-end",
      status: "unexpected",
      error: "x".repeat(100000),
      usage: { output: "y".repeat(100000) },
    });
    await store.append(other.id, "run.start", { runId: "foreign" });
    const page = await history.executionHistoryPage(store, session.id);
    expect(page.items[0]).toMatchObject({ id: "orphan-end", state: "unknown" });
    const detail = await history.executionHistoryDetail(
      store,
      session.id,
      "orphan-end",
      page.snapshot,
    );
    expect(detail.detail).toContain("Started: not recorded");
    expect(detail.detail.length).toBeLessThan(8000);
    await expect(
      history.executionHistoryDetail(store, session.id, "foreign"),
    ).rejects.toThrow(/not found|available/i);
    for (const cursor of [
      { before: 1 },
      { snapshot: -1 },
      { snapshot: 1.5 },
      { snapshot: Number.MAX_SAFE_INTEGER + 1 },
      { snapshot: page.snapshot + 1 },
      { snapshot: page.snapshot, before: 0 },
      { snapshot: page.snapshot, before: page.snapshot + 1 },
    ])
      await expect(
        history.executionHistoryPage(store, session.id, cursor),
      ).rejects.toThrow(/cursor|snapshot|before/i);
    await expect(
      history.executionHistoryDetail(store, session.id, "x".repeat(129)),
    ).rejects.toThrow(/id/i);
    await expect(
      history.executionHistoryPage(store, "missing"),
    ).rejects.toThrow(/session/i);
  } finally {
    await store.close();
  }
});

it("keeps list responses small even when run details need JSON escaping", async () => {
  const store = await SQLiteStore.open(":memory:");
  try {
    const session = await store.createSession("/fixture");
    const field = "\u0001".repeat(4000);
    for (let n = 0; n < 20; n++) {
      await store.append(session.id, "run.start", {
        runId: `escaped-${n}`,
        provider: field,
        model: field,
      });
      await store.append(session.id, "run.end", {
        runId: `escaped-${n}`,
        status: "failed",
        error: field,
        usage: { text: field },
      });
    }
    const page = await history.executionHistoryPage(store, session.id);
    expect(page.items).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024);
    expect(
      page.items.every(
        (item) => item.detail === "" && item.actions.length === 0,
      ),
    ).toBe(true);
    const detail = await history.executionHistoryDetail(
      store,
      session.id,
      "escaped-0",
      page.snapshot,
    );
    expect(detail.detail).toContain(field);
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(128 * 1024);
  } finally {
    await store.close();
  }
});

it("uses range and run-identity indexes after upgrading a database containing history", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-run-index-")),
    path = join(home, "db.sqlite");
  let store = await SQLiteStore.open(path);
  const session = await store.createSession(home);
  await store.append(session.id, "run.start", { runId: "old" });
  await store.close();
  let db = new DatabaseSync(path);
  db.exec("DROP INDEX IF EXISTS session_run_identity");
  db.close();
  store = await SQLiteStore.open(path);
  try {
    expect(
      (await history.executionHistoryPage(store, session.id)).items[0]!.id,
    ).toBe("old");
    db = new DatabaseSync(path);
    const range = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT seq,json_extract(data,'$.runId') FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND seq<=? AND seq<? ORDER BY seq DESC LIMIT 201",
      )
      .all(session.id, 100, 100);
    expect(JSON.stringify(range)).toContain("session_run_events");
    const pair = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT seq,timestamp FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND json_extract(data,'$.runId')=? AND type=? AND seq<=? ORDER BY seq DESC LIMIT 1",
      )
      .all(session.id, "old", "run.start", 100);
    expect(JSON.stringify(pair)).toContain("session_run_identity");
    expect(JSON.stringify([...range, ...pair])).not.toMatch(
      /SCAN events|TEMP B-TREE/,
    );
    db.close();
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("serializes two first-upgrade connections and rolls back a failed index migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-run-migration-")),
    path = join(home, "db.sqlite");
  const original = await SQLiteStore.open(path);
  const session = await original.createSession(home);
  await original.append(session.id, "run.start", { runId: "retained" });
  await original.close();
  let db = new DatabaseSync(path);
  db.exec("DROP INDEX session_run_identity");
  db.close();
  const first = await SQLiteStore.open(path),
    second = await SQLiteStore.open(path);
  try {
    const pages = await Promise.all([
      history.executionHistoryPage(first, session.id),
      history.executionHistoryPage(second, session.id),
    ]);
    expect(pages.map((page) => page.items.map((item) => item.id))).toEqual([
      ["retained"],
      ["retained"],
    ]);
  } finally {
    await first.close();
    await second.close();
  }

  db = new DatabaseSync(path);
  db.exec("DROP INDEX session_run_identity");
  // Corrupt legacy JSON is a deterministic initialization failure. It verifies
  // migration rollback; this is not a physical disk-failure simulation.
  db.prepare(
    "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,'run.end','{',0)",
  ).run(session.id);
  db.close();
  const worker = new Worker(
    new URL("../packages/storage/src/worker.mjs", import.meta.url),
    { workerData: { path } },
  );
  try {
    const failure = await new Promise<Error>((resolve) =>
      worker.once("error", resolve),
    );
    expect(failure.message).toMatch(/malformed JSON/i);
  } finally {
    await worker.terminate();
  }
  db = new DatabaseSync(path);
  try {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='session_run_identity'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE data LIKE '%retained%'",
        )
        .get()!.count,
    ).toBe(1);
    db.prepare("DELETE FROM events WHERE data='{'").run();
  } finally {
    db.close();
  }
  const repaired = await SQLiteStore.open(path);
  try {
    expect(
      (await history.executionHistoryPage(repaired, session.id)).items[0]!.id,
    ).toBe("retained");
  } finally {
    await repaired.close();
    await rm(home, { recursive: true, force: true });
  }
});
