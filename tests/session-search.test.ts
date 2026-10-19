import { afterEach, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { openSessions } from "../packages/tui/src/sessions.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

const stores: SQLiteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it("searches titles and IDs across pages within a workspace, treating wildcards literally", async () => {
  const store = await SQLiteStore.open(":memory:");
  stores.push(store);
  const target = await store.createSession("/a", "修复 100%_Search");
  for (let n = 0; n < 65; n++) await store.createSession("/a", `Recent ${n}`);
  await store.createSession("/b", "修复 100%_Search");
  expect(
    (await store.sessions(0, 50, "/a", "search")).map((s) => s.id),
  ).toEqual([target.id]);
  expect(
    (await store.sessions(0, 50, "/a", target.id.slice(4, 16))).map(
      (s) => s.id,
    ),
  ).toEqual([target.id]);
  expect((await store.sessions(0, 50, "/a", "%_")).map((s) => s.id)).toEqual([
    target.id,
  ]);
  expect((await store.sessions(0, 50, "/a", "修复")).map((s) => s.id)).toEqual([
    target.id,
  ]);
  expect(await store.sessions(0, 50, "/a", "no match")).toEqual([]);
  await expect(store.sessions(-1, 50, "/a")).rejects.toThrow(/pagination/i);
});

it("keeps Unicode case-insensitive title matching from the original picker", async () => {
  const store = await SQLiteStore.open(":memory:");
  stores.push(store);
  const target = await store.createSession("/a", "ÜBER ÉCOLE");
  expect(
    (await store.sessions(0, 50, "/a", "über école")).map((row) => row.id),
  ).toEqual([target.id]);
});

it("searches beyond the initial picker page and keeps the query while paging results", async () => {
  const store = await SQLiteStore.open(":memory:");
  stores.push(store);
  const target = await store.createSession("/a", "Needle oldest");
  for (let n = 0; n < 55; n++) await store.createSession("/a", `Needle ${n}`);
  for (let n = 0; n < 55; n++) await store.createSession("/a", `Other ${n}`);
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  const screen = () => stripVTControlCharacters(panel.render(100).join("\n"));
  const resumed: string[] = [];
  const view = {
    openModelPanel: () => ({ panel, signal: abort.signal, close() {} }),
    setError(error: string) {
      throw Error(error);
    },
  } as unknown as HikaroView;
  const task = openSessions(
    view,
    () => "",
    (offset, limit, query) => store.sessions(offset, limit, "/a", query),
    async (id) => {
      resumed.push(id);
    },
    async () => undefined,
  );
  try {
    await vi.waitFor(() => expect(screen()).toContain("Other"));
    panel.handleInput("Needle");
    await vi.waitFor(() => expect(screen()).toContain("Needle 54"));
    for (let n = 0; n < 50; n++) panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    await vi.waitFor(() => expect(screen()).toContain("Needle oldest"));
    for (let n = 0; n < 5; n++) panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    await task;
    expect(resumed).toEqual([target.id]);
  } finally {
    abort.abort();
    await task;
  }
});

it("ignores stale search responses and disables stale selection while searching", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  let release!: (items: Array<{ value: string; label: string }>) => void;
  const picked = panel.choose(
    "Search",
    [{ value: "old", label: "Old" }],
    "",
    undefined,
    {
      search: true,
      loadItems: async (query) =>
        query === "a"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : [{ value: "ab", label: "Newest result" }],
    },
  );
  let done = false;
  void picked.then(() => {
    done = true;
  });
  panel.handleInput("a");
  panel.handleInput("\r");
  panel.handleInput("b");
  release([{ value: "a", label: "Stale result" }]);
  await vi.waitFor(() =>
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain(
      "Newest result",
    ),
  );
  expect(done).toBe(false);
  panel.handleInput("\r");
  expect(await picked).toMatchObject({ value: "ab", query: "ab" });
});
