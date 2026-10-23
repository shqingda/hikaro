import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rename, readdir } from "node:fs/promises";
import { Planning } from "../packages/runtime/src/planning.ts";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
  };
});

it("retains immutable, paginated plan versions across revisions, approval, cancellation and restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-history-"));
  try {
    let planning = new Planning(home);
    await planning.load("session");
    await planning.setActive("session", true);
    const plans = [];
    for (let i = 1; i <= 23; i++)
      plans.push(
        await planning.propose("session", {
          title: `Plan ${i}`,
          steps: [`Immutable step ${i}`],
          validation: `Check ${i}`,
        }),
      );
    await expect(planning.approve("session", plans[0]!.id)).rejects.toThrow(
      /changed/,
    );
    await planning.approve("session", plans.at(-1)!.id);
    await planning.setActive("session", false);
    planning = new Planning(home);
    await planning.load("session");
    const first = await planning.history("session");
    expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({ revision: 23, title: "Plan 23" });
    expect(first.nextBefore).toBe(4);
    expect(first.incomplete).toBe(false);
    const second = await planning.history("session", first.nextBefore!);
    expect(second.items.map((row) => row.revision)).toEqual([3, 2, 1]);
    expect(second.nextBefore).toBeNull();
    expect(await planning.version("session", plans[0]!.id)).toEqual(plans[0]);
    await planning.load("other");
    await expect(planning.version("other", plans[0]!.id)).rejects.toThrow(
      /not found/,
    );
    await expect(planning.version("session", "../escape")).rejects.toThrow();
    await planning.removeSession("session");
    await planning.load("session");
    expect((await planning.history("session")).items).toEqual([]);
    const path = join(
      home,
      "plans",
      createHash("sha256").update("session").digest("hex") + ".json",
    );
    await expect(
      readFile(join(path + ".versions", plans[0]!.id + ".json")),
    ).rejects.toThrow(/ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("shows only the retained legacy plan and preserves it before leaving Plan mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-legacy-"));
  const path = join(
    home,
    "plans",
    createHash("sha256").update("old").digest("hex") + ".json",
  );
  const plan = {
    id: randomUUID(),
    title: "Existing plan",
    steps: ["Original"],
    validation: "Original validation",
  };
  try {
    await mkdir(join(home, "plans"));
    await writeFile(path, JSON.stringify({ active: true, plan }));
    let planning = new Planning(home);
    await planning.load("old");
    expect(await planning.history("old")).toMatchObject({
      items: [{ id: plan.id, title: plan.title }],
      incomplete: true,
    });
    expect(await planning.version("old", plan.id)).toEqual(plan);
    await planning.setActive("old", false);
    planning = new Planning(home);
    await planning.load("old");
    expect((await planning.history("old")).incomplete).toBe(true);
    expect(await planning.version("old", plan.id)).toEqual(plan);
    expect(planning.get("old")).toEqual({ active: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("does not let a delayed refresh discard a successfully committed plan version", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-refresh-"));
  try {
    const planning = new Planning(home);
    await planning.load("session");
    await planning.setActive("session", true);
    const proposal = { title: "First", steps: ["Step"], validation: "Check" };
    const first = await planning.propose("session", proposal);
    let captured!: () => void;
    const reading = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let release!: () => void;
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(readFile).mockImplementationOnce(
      async (...args: Parameters<typeof readFile>) => {
        const saved = await actual.readFile(...args);
        captured();
        await resumed;
        return saved;
      },
    );
    const refresh = planning.load("session", true);
    await reading;
    const second = await planning.propose("session", {
      ...proposal,
      title: "Second",
    });
    release();
    await refresh;
    const third = await planning.propose("session", {
      ...proposal,
      title: "Third",
    });
    const reopened = new Planning(home);
    await reopened.load("session");
    expect(
      (await reopened.history("session")).items.map((item) => item.id),
    ).toEqual([third.id, second.id, first.id]);
    expect(await reopened.version("session", second.id)).toEqual(second);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("does not expose an orphan snapshot when committing the current state fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-failed-save-"));
  try {
    const planning = new Planning(home);
    await planning.load("session");
    await planning.setActive("session", true);
    const proposal = { title: "First", steps: ["Step"], validation: "Check" };
    const first = await planning.propose("session", proposal);
    vi.mocked(rename).mockRejectedValueOnce(
      Error("Injected state commit failure"),
    );
    await expect(
      planning.propose("session", { ...proposal, title: "Uncommitted" }),
    ).rejects.toThrow("Injected state commit failure");
    expect(planning.get("session").plan!.id).toBe(first.id);
    const reopened = new Planning(home);
    await reopened.load("session");
    const third = await reopened.propose("session", {
      ...proposal,
      title: "Third",
    });
    expect(
      (await reopened.history("session")).items.map((item) => item.id),
    ).toEqual([third.id, first.id]);
    const versions = join(
      home,
      "plans",
      createHash("sha256").update("session").digest("hex") + ".json.versions",
    );
    expect(
      (await readdir(versions)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(3);
    await reopened.removeSession("session");
    await expect(readdir(versions)).rejects.toThrow(/ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses to overwrite conflicting contents for an existing snapshot ID", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-conflict-"));
  const path = join(
    home,
    "plans",
    createHash("sha256").update("old").digest("hex") + ".json",
  );
  const plan = {
    id: randomUUID(),
    title: "Legacy",
    steps: ["Original"],
    validation: "Check",
  };
  const state = JSON.stringify({ active: true, plan });
  const conflicting = JSON.stringify({
    ...plan,
    title: "Existing different snapshot",
  });
  try {
    await mkdir(path + ".versions", { recursive: true });
    await writeFile(path, state);
    const versionPath = join(path + ".versions", plan.id + ".json");
    await writeFile(versionPath, conflicting);
    const planning = new Planning(home);
    await planning.load("old");
    await expect(planning.setActive("old", false)).rejects.toThrow(
      /history was not overwritten/,
    );
    expect(await readFile(path, "utf8")).toBe(state);
    expect(await readFile(versionPath, "utf8")).toBe(conflicting);
    expect(planning.get("old")).toEqual({ active: true, plan });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
