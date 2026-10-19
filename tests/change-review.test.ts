import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeJournal } from "../packages/tools/src/changes.ts";

const folders: string[] = [];
afterEach(async () => {
  for (const path of folders.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hikaro-changes-")));
  folders.push(root);
  const journal = new ChangeJournal(join(root, "data"));
  return {
    root,
    journal,
    path: join(root, "code.txt"),
    signal: new AbortController().signal,
  };
}
it("persists an edit, shows before/after, and restores original contents after restart", async () => {
  const { root, journal, path, signal } = await fixture();
  await writeFile(path, "original\n", { mode: 0o640 });
  await journal.update("session", path, signal, () => "changed\n");
  const reopened = new ChangeJournal(join(root, "data"));
  const [entry] = await reopened.list("session");
  expect(await reopened.detail("session", entry!.id)).toMatchObject({
    before: "original\n",
    after: "changed\n",
  });
  await reopened.rollback("session", entry!.id, signal);
  expect(await readFile(path, "utf8")).toBe("original\n");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  expect((await reopened.list("session"))[0]!.state).toBe("reverted");
});
it("removes only an unchanged newly created file and rejects repeat rollback", async () => {
  const { journal, path, signal } = await fixture();
  await journal.update("session", path, signal, () => "new");
  const [entry] = await journal.list("session");
  await journal.rollback("session", entry!.id, signal);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(journal.rollback("session", entry!.id, signal)).rejects.toThrow(
    /reverted/,
  );
});
it("preserves later edits, supports reverse-order rollback, and isolates sessions", async () => {
  const { journal, path, signal } = await fixture();
  await writeFile(path, "original");
  await journal.update("session", path, signal, () => "one");
  const [first] = await journal.list("session");
  await journal.update("session", path, signal, () => "two");
  const [second] = await journal.list("session");
  await expect(journal.rollback("session", first!.id, signal)).rejects.toThrow(
    /changed/,
  );
  expect(await readFile(path, "utf8")).toBe("two");
  await expect(journal.detail("other", first!.id)).rejects.toThrow();
  await journal.rollback("session", second!.id, signal);
  await journal.rollback("session", first!.id, signal);
  expect(await readFile(path, "utf8")).toBe("original");
});
it("does not change a file when checkpoint or snapshot persistence fails", async () => {
  const { root, journal, path, signal } = await fixture();
  await writeFile(path, "original");
  await expect(
    journal.update(
      "session",
      path,
      signal,
      () => "new",
      async () => {
        throw Error("Lease lost");
      },
    ),
  ).rejects.toThrow("Lease lost");
  expect(await readFile(path, "utf8")).toBe("original");
  await writeFile(join(root, "blocked"), "file");
  await expect(
    new ChangeJournal(join(root, "blocked")).update(
      "session",
      path,
      signal,
      () => "new",
    ),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("original");
});

it("rejects interrupted records and tampered snapshots without touching the workspace", async () => {
  const { root, journal, path, signal } = await fixture();
  await writeFile(path, "original");
  let checks = 0;
  await expect(
    journal.update(
      "session",
      path,
      signal,
      () => "changed",
      async () => {
        if (++checks === 2) throw Error("Interrupted after prepare");
      },
    ),
  ).rejects.toThrow("Interrupted");
  const [pending] = await journal.list("session");
  expect(pending!.state).toBe("prepared");
  await expect(
    journal.rollback("session", pending!.id, signal),
  ).rejects.toThrow("prepared");
  expect(await readFile(path, "utf8")).toBe("original");
  await journal.update("session", path, signal, () => "changed");
  const [entry] = await journal.list("session");
  const { createHash } = await import("node:crypto");
  const folder = join(
    root,
    "data",
    "changes",
    createHash("sha256").update("session").digest("hex"),
  );
  await writeFile(join(folder, `${entry!.before}.txt`), "damaged");
  await expect(journal.rollback("session", entry!.id, signal)).rejects.toThrow(
    "damaged",
  );
  expect(await readFile(path, "utf8")).toBe("changed");
});

it("refuses deletion after a concurrent replacement at the commit boundary", async () => {
  const { journal, path, signal } = await fixture();
  await journal.update("session", path, signal, () => "created");
  const [entry] = await journal.list("session");
  await expect(
    journal.rollback("session", entry!.id, signal, async () => {
      await writeFile(path, "external edit");
    }),
  ).rejects.toThrow(/changed/);
  expect(await readFile(path, "utf8")).toBe("external edit");
});

it("serializes competing rollbacks without applying the same change twice", async () => {
  const { journal, path, signal } = await fixture();
  await writeFile(path, "original");
  await journal.update("session", path, signal, () => "changed");
  const [entry] = await journal.list("session");
  const results = await Promise.allSettled([
    journal.rollback("session", entry!.id, signal),
    journal.rollback("session", entry!.id, signal),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(path, "utf8")).toBe("original");
});
