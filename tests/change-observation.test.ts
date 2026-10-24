import { expect, it } from "vitest";
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
