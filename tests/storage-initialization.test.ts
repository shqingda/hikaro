import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("rolls back all new schema objects if the existing lease migration fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hikaro-schema-"));
  const path = join(directory, "db.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec(
    "CREATE VIEW leases AS SELECT 'session' AS sessionId, 'owner' AS owner, 0 AS expires",
  );
  seed.close();
  const store = await SQLiteStore.open(path);
  try {
    await expect(store.createSession(directory)).rejects.toThrow(/view|alter/i);
    const db = new DatabaseSync(path);
    try {
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='sessions'")
          .get(),
      ).toBeUndefined();
      expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
    } finally {
      db.close();
    }
  } finally {
    // Startup failed and the worker has already exited.
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
