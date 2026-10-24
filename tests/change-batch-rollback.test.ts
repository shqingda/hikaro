import { expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChangeJournal,
  type FileChange,
} from "../packages/tools/src/changes.ts";
import {
  batchRollbackTargets,
  runBatchRollback,
  runRollbackTargets,
} from "../packages/tui/src/change-review.ts";

const entry = (state: FileChange["state"], timestamp: number): FileChange => ({
  id: randomUUID(),
  path: `/w/${timestamp}`,
  timestamp,
  before: null,
  after: "a".repeat(64),
  state,
});

it("selects committed changes from newest through the chosen one", () => {
  const newest = entry("committed", 4),
    reverted = entry("reverted", 3),
    chosen = entry("committed", 2),
    older = entry("committed", 1);
  const list = [newest, reverted, chosen, older];
  expect(batchRollbackTargets(list, chosen.id).map((e) => e.id)).toEqual([
    newest.id,
    chosen.id,
  ]);
  // A lone committed change keeps the single rollback path.
  expect(batchRollbackTargets(list, newest.id)).toEqual([]);
  expect(
    batchRollbackTargets([entry("reverted", 9), chosen], chosen.id),
  ).toEqual([]);
  expect(() =>
    batchRollbackTargets([entry("reverting", 5), chosen], chosen.id),
  ).toThrow(/unfinished/);
  expect(() =>
    batchRollbackTargets([entry("prepared", 5), newest, chosen], chosen.id),
  ).toThrow(/unfinished/);
  expect(batchRollbackTargets(list, reverted.id)).toEqual([]);
});

it("rolls back several files in reverse order and stops at the first conflict", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-batch-rollback-")),
  );
  try {
    const journal = new ChangeJournal(join(root, "journal"));
    const a = join(root, "a.txt"),
      b = join(root, "b.txt");
    await writeFile(a, "a0");
    const signal = new AbortController().signal;
    // Distinct timestamps keep the journal's newest-first order deterministic.
    const edit = async (path: string, text: string) => {
      await new Promise((done) => setTimeout(done, 2));
      await journal.update("s", path, signal, () => text);
    };
    await edit(a, "a1");
    await edit(b, "b1"); // creates b.txt
    await edit(a, "a2");
    let list = await journal.list("s");
    const oldest = list.at(-1)!;
    let targets = batchRollbackTargets(list, oldest.id);
    expect(targets).toHaveLength(3);
    const rollback = (id: string) =>
      journal.rollback("s", id, signal).then(() => {});
    let result = await runBatchRollback(targets, rollback, signal);
    expect(result).toEqual({ completed: 3, total: 3 });
    expect(await readFile(a, "utf8")).toBe("a0");
    await expect(readFile(b, "utf8")).rejects.toThrow();

    // Newer work in the middle file must be preserved and stop the batch.
    await edit(a, "a3");
    await edit(b, "b2");
    await edit(a, "a4");
    await writeFile(b, "user edit");
    list = await journal.list("s");
    const firstOfRound = list.find(
      (row) =>
        row.state === "committed" && row.path === a && list.indexOf(row) === 2,
    )!;
    targets = batchRollbackTargets(list, firstOfRound.id);
    expect(targets).toHaveLength(3);
    result = await runBatchRollback(targets, rollback, signal);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.failed?.entry.path).toBe(b);
    expect(String(result.failed?.error)).toMatch(/changed after this edit/);
    expect(await readFile(a, "utf8")).toBe("a3");
    expect(await readFile(b, "utf8")).toBe("user edit");
    const states = (await journal.list("s")).slice(0, 3).map((r) => r.state);
    expect(states).toEqual(["reverted", "committed", "committed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stops before the next change once cancelled", async () => {
  const controller = new AbortController();
  const targets = [entry("committed", 3), entry("committed", 2)];
  const done: string[] = [];
  const result = await runBatchRollback(
    targets,
    async (id) => {
      done.push(id);
      controller.abort();
    },
    controller.signal,
  );
  expect(done).toEqual([targets[0]!.id]);
  expect(result.completed).toBe(1);
  expect(result.failed?.entry.id).toBe(targets[1]!.id);
});

it("groups recorded edits by run and rolls back only the chosen run", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-run-rollback-")),
  );
  try {
    const journal = new ChangeJournal(join(root, "journal"));
    const a = join(root, "a.txt"),
      b = join(root, "b.txt"),
      c = join(root, "c.txt");
    const signal = new AbortController().signal;
    const edit = async (path: string, text: string, runId?: string) => {
      await new Promise((done) => setTimeout(done, 2));
      await journal.update("s", path, signal, () => text, undefined, runId);
    };
    await edit(a, "run1-a", "run-1");
    await edit(b, "run1-b", "run-1");
    await edit(c, "run2-c", "run-2");
    await edit(c, "legacy-c"); // recorded before run ids existed
    const list = await journal.list("s");
    expect(list.map((row) => row.runId)).toEqual([
      undefined,
      "run-2",
      "run-1",
      "run-1",
    ]);
    const first = list.find((row) => row.path === b)!;
    const targets = runRollbackTargets(list, first.id);
    expect(targets.map((row) => row.path)).toEqual([b, a]);
    expect(runRollbackTargets(list, list[0]!.id)).toEqual([]);
    expect(runRollbackTargets(list, list[1]!.id)).toEqual([]);
    const result = await runBatchRollback(
      targets,
      (id) => journal.rollback("s", id, signal).then(() => {}),
      signal,
    );
    expect(result).toEqual({ completed: 2, total: 2 });
    await expect(readFile(a, "utf8")).rejects.toThrow();
    await expect(readFile(b, "utf8")).rejects.toThrow();
    expect(await readFile(c, "utf8")).toBe("legacy-c");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
