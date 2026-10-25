import { afterEach, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeJournal } from "../packages/tools/src/changes.ts";
import { ChangeObservations } from "../packages/tools/src/change-observations.ts";
import { ChangeReview } from "../packages/runtime/src/change-review.ts";
import * as secureFiles from "../packages/tools/src/secure-files.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const folders: string[] = [];
const session = "history";
const digest = createHash("sha256").update(session).digest("hex");
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Kind = "journal" | "observations" | "coverage";
const kinds: Kind[] = ["journal", "observations", "coverage"];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function fixture(kind: Kind, count = 1) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-change-history-")),
  );
  folders.push(home);
  const directory = join(
    home,
    kind === "journal" ? "changes" : "observations",
    digest,
  );
  await mkdir(directory, { recursive: true });
  const record = (n: number) =>
    kind === "coverage"
      ? [`warning-${n}`]
      : {
          id: id(n),
          path: `/workspace/file-${n}.txt`,
          timestamp: n,
          before: null,
          after: "a".repeat(64),
          ...(kind === "journal"
            ? { state: "committed" }
            : { source: "shell", callId: `call-${n}` }),
        };
  const path = (n: number) =>
    join(directory, `${id(n)}.${kind === "coverage" ? "coverage" : "json"}`);
  for (let n = 0; n < count; n++)
    await writeFile(path(n), JSON.stringify(record(n)));
  const journal = new ChangeJournal(home);
  const observations = new ChangeObservations(home);
  return {
    home,
    directory,
    path,
    record,
    list: () =>
      kind === "journal"
        ? journal.list(session)
        : kind === "observations"
          ? observations.list(session)
          : observations.warnings(session),
    detail: () =>
      kind === "journal"
        ? journal.detail(session, id(0))
        : observations.detail(session, id(0)),
  };
}

it.each(kinds)(
  "reads %s history with bounded native startup overhead and no stale cache",
  async (kind) => {
    const count = kind === "coverage" ? 100 : 201;
    const { list, path, record } = await fixture(kind, count);
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const rows = await list();
    expect(rows).toHaveLength(count);
    if (kind === "journal")
      expect(rows[0]).toMatchObject({ id: id(count - 1) });
    // The resource budget guards process churn, independent of exact batch size.
    expect(spawn.mock.calls.length).toBeGreaterThan(0);
    expect(spawn.mock.calls.length).toBeLessThanOrEqual(5);
    await writeFile(
      path(0),
      JSON.stringify(
        kind === "coverage"
          ? ["updated warning"]
          : { ...record(0), path: "/workspace/updated.txt" },
      ),
    );
    const updated = await list();
    expect(updated).toContainEqual(
      kind === "coverage"
        ? "updated warning"
        : expect.objectContaining({
            id: id(0),
            path: "/workspace/updated.txt",
          }),
    );
  },
);

it.each(kinds)(
  "rejects the entire %s list after provisional results and a batch failure",
  async (kind) => {
    const { list, record } = await fixture(kind);
    const batch = vi
      .spyOn(secureFiles, "readFileBytesBatch")
      .mockImplementationOnce(async (_paths, _signal, receive) => {
        receive(
          {
            status: "fulfilled",
            value: Buffer.from(JSON.stringify(record(0))),
          },
          0,
        );
        throw Error("interrupted metadata batch");
      });
    await expect(list()).rejects.toThrow("interrupted metadata batch");
    batch.mockRestore();
    expect(await list()).toHaveLength(1);
  },
);

it.each(
  kinds.flatMap((kind) =>
    ["invalid JSON", "invalid schema", "linked file", "oversized file"].map(
      (damage) => ({ kind, damage }),
    ),
  ),
)("rejects $damage in $kind history", async ({ kind, damage }) => {
  const { list, path, home } = await fixture(kind);
  if (damage === "linked file") {
    const outside = join(home, "target");
    await writeFile(outside, "[]");
    await rm(path(0));
    await symlink(outside, path(0));
  } else {
    await writeFile(
      path(0),
      damage === "invalid JSON"
        ? "{"
        : damage === "invalid schema"
          ? JSON.stringify(kind === "coverage" ? [1] : {})
          : " ".repeat((kind === "coverage" ? 8192 : 65536) + 1),
    );
  }
  await expect(list()).rejects.toThrow();
});

it.each(["journal", "observations"] as const)(
  "reports unavailable %s snapshots while retaining their history record",
  async (kind) => {
    const { list, detail } = await fixture(kind);
    expect(await list()).toHaveLength(1);
    await expect(detail()).rejects.toThrow(
      "Snapshot unavailable (removed or cleaned); diff, rollback and redo are unavailable.",
    );
  },
);

it.each(["journal", "observations"] as const)(
  "preserves %s filename and record identity validation",
  async (kind) => {
    const { list, path, directory, record } = await fixture(kind);
    await writeFile(path(0), JSON.stringify({ ...record(0), id: id(1) }));
    await expect(list()).rejects.toThrow(/identity/);
    await rm(path(0));
    await writeFile(
      join(directory, "not-a-uuid.json"),
      JSON.stringify(record(0)),
    );
    await expect(list()).rejects.toThrow();
  },
);

it("coalesces only exact call or parent-call, path and hash matches", async () => {
  const common = {
    path: "/workspace/a",
    timestamp: 1,
    before: null,
    after: "a".repeat(64),
  };
  const reliable = [
    {
      id: id(0),
      ...common,
      state: "committed",
      origin: { callId: "nested", parentCallId: "outer" },
    },
    { id: id(1), ...common, state: "committed", path: "/workspace/no-origin" },
    {
      id: id(2),
      ...common,
      state: "committed",
      path: "/workspace/empty",
      origin: { callId: "" },
    },
    {
      id: id(3),
      ...common,
      state: "committed",
      path: "/b",
      origin: { callId: "part|/workspace" },
    },
  ];
  const observed = [
    { callId: "nested" },
    { callId: "outer" },
    { callId: "different" },
    { callId: "nested", path: "/workspace/other" },
    { callId: "nested", before: "b".repeat(64) },
    { callId: "nested", after: "b".repeat(64) },
    { callId: "nested", after: null },
    { callId: "no-origin", path: "/workspace/no-origin" },
    { callId: "", path: "/workspace/empty" },
    { callId: "part", path: "/workspace|/b" },
  ].map((row, n) => ({ id: id(n + 10), ...common, source: "shell", ...row }));
  const review = new ChangeReview(
    { childTaskTree: async () => [] } as never,
    { list: async () => reliable } as never,
    { list: async () => observed, warnings: async () => [] } as never,
  );
  const rows = (await review.list(session)).items;
  expect(rows.filter((row) => row.source === "file")).toHaveLength(4);
  expect(
    rows
      .filter((row) => row.source === "shell")
      .map((row) => row.id)
      .sort(),
  ).toEqual([12, 13, 14, 15, 16, 17, 19].map(id));
});
