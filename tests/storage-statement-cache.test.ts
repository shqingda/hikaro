import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
const modulePath = new URL(
  "../packages/storage/src/statement-cache.mjs",
  import.meta.url,
).href;
it("reuses compilation while reading fresh rows with fresh bindings", async () => {
  const { createStatementCache } = await import(modulePath);
  const db = new DatabaseSync(":memory:");
  let compilations = 0;
  const prepare = createStatementCache({
    prepare(sql: string) {
      compilations++;
      return db.prepare(sql);
    },
  });
  try {
    db.exec(
      "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'first'),(2,'second')",
    );
    for (let i = 0; i < 1000; i++)
      expect(
        prepare("SELECT value FROM items WHERE id=?").get((i % 2) + 1)?.value,
      ).toBe(i % 2 ? "second" : "first");
    expect(compilations).toBe(1);
    db.exec("UPDATE items SET value='updated' WHERE id=1");
    expect(prepare("SELECT value FROM items WHERE id=?").get(1)?.value).toBe(
      "updated",
    );
    expect(
      prepare("SELECT value FROM items WHERE id=?").get(3),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
it("bounds distinct SQL shapes and does not cache failed preparation", async () => {
  const { createStatementCache } = await import(modulePath);
  const db = new DatabaseSync(":memory:");
  let compilations = 0;
  const prepare = createStatementCache(
    {
      prepare(sql: string) {
        compilations++;
        return db.prepare(sql);
      },
    },
    2,
  );
  try {
    prepare("SELECT 1");
    prepare("SELECT 2");
    prepare("SELECT 1");
    prepare("SELECT 3");
    prepare("SELECT 2");
    expect(compilations).toBe(4);
    expect(() => prepare("SELECT value FROM later")).toThrow();
    db.exec(
      "CREATE TABLE later(value TEXT); INSERT INTO later VALUES('ready')",
    );
    expect(prepare("SELECT value FROM later").get()?.value).toBe("ready");
  } finally {
    db.close();
  }
});
