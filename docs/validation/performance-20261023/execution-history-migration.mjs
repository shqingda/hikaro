import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { SQLiteStore } from "../../../packages/storage/src/index.ts";
import {
  executionHistoryPage,
  executionHistoryDetail,
} from "../../../packages/runtime/src/execution-history.ts";
const home = await mkdtemp(join(tmpdir(), "hikaro-history-migration-"));
const path = join(home, "sessions.sqlite");
const seed = await SQLiteStore.open(path);
const session = await seed.createSession(home);
await seed.close();
const db = new DatabaseSync(path);
db.exec("DROP INDEX session_run_identity; BEGIN IMMEDIATE");
const insert = db.prepare(
  "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,?,?,?)",
);
const padding = "x".repeat(256);
for (let n = 0; n < 100000; n++) {
  const type =
    n % 10 === 0 ? "run.start" : n % 10 === 1 ? "run.end" : "message";
  const runId = `migration-${Math.floor(n / 10)}`;
  const data =
    type === "run.start"
      ? { runId, provider: "fixture", model: "old" }
      : type === "run.end"
        ? { runId, status: "completed" }
        : { text: padding };
  insert.run(session.id, type, JSON.stringify(data), 1700000000000 + n);
}
db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
const counts = db
  .prepare(
    "SELECT count(*) AS totalEvents,sum(type IN ('run.start','run.end')) AS runEvents FROM events",
  )
  .get();
db.close();
const bytesBefore = (await stat(path)).size;
const started = performance.now();
const first = await SQLiteStore.open(path),
  second = await SQLiteStore.open(path);
try {
  const pages = await Promise.all([
    executionHistoryPage(first, session.id),
    executionHistoryPage(second, session.id),
  ]);
  const upgradeAndFirstTwoPagesMs = performance.now() - started;
  const detailStarted = performance.now();
  const detail = await executionHistoryDetail(
    first,
    session.id,
    "migration-0",
    pages[0].snapshot,
  );
  const exactOldDetailMs = performance.now() - detailStarted;
  const pageStarted = performance.now();
  const page = await executionHistoryPage(first, session.id, {
    snapshot: pages[0].snapshot,
    before: pages[0].nextBefore,
  });
  const subsequentPageMs = performance.now() - pageStarted;
  const inspect = new DatabaseSync(path);
  const rangePlan = inspect
    .prepare(
      "EXPLAIN QUERY PLAN SELECT seq,json_extract(data,'$.runId') FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND seq<=? AND seq<? ORDER BY seq DESC LIMIT 201",
    )
    .all(session.id, pages[0].snapshot, pages[0].nextBefore);
  const pairPlan = inspect
    .prepare(
      "EXPLAIN QUERY PLAN SELECT seq,timestamp FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND json_extract(data,'$.runId')=? AND type=? AND seq<=? ORDER BY seq DESC LIMIT 1",
    )
    .all(session.id, "migration-0", "run.start", pages[0].snapshot);
  const indexCreated = !!inspect
    .prepare("SELECT name FROM sqlite_master WHERE name='session_run_identity'")
    .get();
  inspect.close();
  const report = {
    measuredAt: new Date().toISOString(),
    workload:
      "Synthetic existing database; concurrent repository tests may run. Timings are one observation, not an idle baseline or performance gate.",
    ...counts,
    runs: 10000,
    bytesBefore,
    upgradeAndFirstTwoPagesMs,
    exactOldDetailMs,
    subsequentPageMs,
    concurrentFirstPages: pages.map((p) => ({
      count: p.items.length,
      first: p.items[0].id,
      last: p.items.at(-1).id,
      snapshot: p.snapshot,
      nextBefore: p.nextBefore,
      jsonBytes: Buffer.byteLength(JSON.stringify(p)),
    })),
    nextPage: {
      count: page.items.length,
      first: page.items[0].id,
      last: page.items.at(-1).id,
    },
    exactOldDetail: {
      id: detail.id,
      state: detail.state,
      pairedStart: detail.detail.includes("fixture/old"),
    },
    indexCreated,
    rangePlan,
    pairPlan,
  };
  await writeFile(
    new URL("./execution-history-migration.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await first.close();
  await second.close();
  await rm(home, { recursive: true, force: true });
}
