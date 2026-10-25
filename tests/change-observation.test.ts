import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChangeObservations } from "../packages/tools/src/change-observations.ts";
import * as secureFiles from "../packages/tools/src/secure-files.ts";

it("records bounded text changes without following links or exposing sensitive and ignored files", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-observe-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, ".ignore"), "ignored.txt\n");
  for (const [path, text] of [
    ["edit.txt", "before"],
    ["deleted.txt", "gone"],
    [".env", "private"],
    ["ignored.txt", "ignored"],
  ])
    await writeFile(join(cwd, path!), text!);
  await writeFile(join(home, "outside.txt"), "outside");
  await symlink(join(home, "outside.txt"), join(cwd, "link.txt"));
  const journal = new ChangeObservations(home);
  try {
    await expect(
      journal.capture(
        "s1",
        cwd,
        { source: "shell", callId: "failed-call" },
        async () => {
          await writeFile(join(cwd, "edit.txt"), "after");
          await rm(join(cwd, "deleted.txt"));
          await writeFile(join(cwd, "created.txt"), "new");
          await writeFile(join(cwd, ".env"), "still private");
          throw Error("command failed after writing");
        },
      ),
    ).rejects.toThrow("command failed");
    const rows = await journal.list("s1");
    expect(rows.map((row) => row.path.split("/").at(-1)).sort()).toEqual([
      "created.txt",
      "deleted.txt",
      "edit.txt",
    ]);
    expect(
      rows.every(
        (row) => row.source === "shell" && row.callId === "failed-call",
      ),
    ).toBe(true);
    const restored = new ChangeObservations(home);
    const deleted = rows.find((row) => row.path.endsWith("deleted.txt"))!;
    expect(await restored.detail("s1", deleted.id)).toMatchObject({
      before: "gone",
      after: undefined,
    });
    expect(await restored.list("other")).toEqual([]);
    expect(await readFile(join(home, "outside.txt"), "utf8")).toBe("outside");
    await journal.removeSession("s1");
    expect(await journal.list("s1")).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("marks omitted large files and never turns missing evidence into a deletion", async () => {
  const { truncate, realpath } = await import("node:fs/promises");
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-observe-limits-")),
  );
  const cwd = join(home, "work");
  await mkdir(cwd);
  const path = join(cwd, "large.txt");
  await writeFile(path, "before");
  const observations = new ChangeObservations(home);
  try {
    await observations.capture(
      "s",
      cwd,
      { source: "plugin", callId: "large" },
      () => truncate(path, 16 * 1024 * 1024 + 1),
    );
    expect(await observations.list("s")).toEqual([]);
    expect((await observations.warnings("s")).join(" ")).toContain("16 MiB");
    await observations.capture(
      "s",
      cwd,
      { source: "plugin", callId: "small" },
      () => writeFile(path, "after"),
    );
    expect(await observations.list("s")).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("discards provisional batch data and cannot infer changes from an interrupted inventory", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-observe-interrupted-"));
  const cwd = join(home, "work");
  await mkdir(cwd);
  await writeFile(join(cwd, "edited.txt"), "before");
  const batch = vi
    .spyOn(secureFiles, "readFileBytesBatch")
    .mockImplementationOnce(async (_paths, _signal, receive) => {
      receive({ status: "fulfilled", value: Buffer.from("before") }, 0);
      throw Error("Helper IPC interrupted after a provisional result");
    });
  const observations = new ChangeObservations(home);
  try {
    await observations.capture(
      "s",
      cwd,
      { source: "shell", callId: "test" },
      async () => {
        await writeFile(join(cwd, "edited.txt"), "after");
        await writeFile(join(cwd, "created.txt"), "new");
      },
    );
    expect(await observations.list("s")).toEqual([]);
    expect((await observations.warnings("s")).join(" ")).toContain(
      "could not be read safely",
    );
  } finally {
    batch.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});

it("observes multiple small-file batches and retains the 16 MiB single-file boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-observe-batches-"));
  const cwd = join(home, "work");
  await mkdir(cwd);
  const small = Array.from({ length: 101 }, (_, i) =>
    join(cwd, `small-${String(i).padStart(3, "0")}.txt`),
  );
  await Promise.all(small.map((path) => writeFile(path, "before")));
  const large = join(cwd, "large.txt"),
    size = 16 * 1024 * 1024;
  await writeFile(large, "a".repeat(size));
  const observations = new ChangeObservations(home);
  try {
    await observations.capture(
      "s",
      cwd,
      { source: "shell", callId: "test" },
      async () => {
        await writeFile(small[99]!, "after");
        await rm(small[100]!);
        await writeFile(large, "a".repeat(size - 1) + "b");
      },
    );
    const rows = await observations.list("s");
    expect(rows.map((row) => row.path.split("/").at(-1)).sort()).toEqual([
      "large.txt",
      "small-099.txt",
      "small-100.txt",
    ]);
    const detail = await observations.detail(
      "s",
      rows.find((row) => row.path.endsWith("large.txt"))!.id,
    );
    expect(detail.before?.length).toBe(size);
    expect(detail.after?.length).toBe(size);
    expect(detail.before?.slice(-1)).toBe("a");
    expect(detail.after?.slice(-1)).toBe("b");
    expect(await observations.warnings("s")).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("shares the 64 MiB byte budget across both snapshots without fabricating deletions", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-observe-total-"));
  const cwd = join(home, "work");
  await mkdir(cwd);
  const paths = Array.from({ length: 17 }, (_, i) =>
    join(cwd, `file-${String(i).padStart(2, "0")}.txt`),
  );
  const text = "a".repeat(2_000_000);
  await Promise.all(paths.map((path) => writeFile(path, text)));
  const observations = new ChangeObservations(home);
  try {
    await observations.capture(
      "s",
      cwd,
      { source: "shell", callId: "test" },
      async () => {
        await writeFile(paths[0]!, text.slice(0, -1) + "b");
        await writeFile(paths[16]!, text.slice(0, -1) + "b");
      },
    );
    const rows = await observations.list("s");
    expect(rows.map((row) => row.path.split("/").at(-1))).toEqual([
      "file-00.txt",
    ]);
    expect(rows[0]?.before).not.toBeNull();
    expect(rows[0]?.after).not.toBeNull();
    expect((await observations.warnings("s")).join(" ")).toContain("64 MiB");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
