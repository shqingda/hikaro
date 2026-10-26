import { expect, it, vi } from "vitest";
import {
  sessionCommand,
  type SessionBackend,
} from "../packages/tui/src/sessions.ts";
import { openMessageSearch } from "../packages/tui/src/message-search.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
import type { Session } from "../packages/core/src/types.ts";

const row = (id: string) => ({ id, title: `Title ${id}` }) as Session;

function harness(choices: Array<{ value: string; action?: string }>) {
  const controller = new AbortController();
  const choose = vi.fn(async () => choices.shift()!);
  const view = {
    openModelPanel: () => ({
      panel: { choose, progress() {}, setTitle() {}, prompt: vi.fn() },
      signal: controller.signal,
      close() {},
    }),
    setError(error: string) {
      throw Error(error);
    },
  } as unknown as HikaroView;
  const calls: string[] = [];
  let current = "a";
  const backend: SessionBackend = {
    current: () => current,
    list: async () => [row("a"), row("b")],
    flush: async () => {
      calls.push("flush");
    },
    open: async (id) => {
      calls.push(`open ${id}`);
      current = id;
    },
    create: async () => {
      calls.push("create");
      current = "new";
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      return id === "a" ? "branch kept" : undefined;
    },
  };
  return { view, backend, calls, choose };
}

it("flushes the draft before /resume ID switches without opening the picker", async () => {
  const { view, backend, calls, choose } = harness([]);
  await sessionCommand(view, "resume", "b", backend);
  expect(calls).toEqual(["flush", "open b"]);
  expect(choose).not.toHaveBeenCalled();
});

it("replaces only a deleted current session and keeps the cleanup warning", async () => {
  const { view, backend, calls, choose } = harness([
    { value: "b", action: "delete" },
    { value: "delete" },
    { value: "a", action: "delete" },
    { value: "delete" },
    { value: "b" },
  ]);
  await sessionCommand(view, "sessions", "", backend);
  expect(calls).toEqual([
    "flush",
    "remove b",
    "flush",
    "remove a",
    "create",
    "flush",
    "open b",
  ]);
  // The list after deleting the current session reports its cleanup error.
  expect((choose.mock.calls as unknown[][])[4]![2]).toBe("branch kept");
});

it("passes the /sessions argument as the initial search but not /resume's", async () => {
  for (const [command, query] of [
    ["sessions", "needle"],
    ["resume", ""],
  ] as const) {
    const { view, backend } = harness([{ value: "b" }]);
    const list = vi.spyOn(backend, "list");
    await sessionCommand(
      view,
      command,
      command === "sessions" ? query : "",
      backend,
    );
    expect(list).toHaveBeenCalledWith(0, 51, query);
  }
});

it("rejects a message section that does not advance instead of looping", async () => {
  const controller = new AbortController();
  const choose = vi.fn().mockResolvedValueOnce({ value: "7" });
  const readDocument = vi.fn().mockResolvedValue({ value: "next" });
  const view = {
    openModelPanel: () => ({
      panel: { choose, readDocument, progress() {}, prompt: vi.fn() },
      signal: controller.signal,
      close() {},
    }),
  } as unknown as HikaroView;
  const content = vi
    .fn()
    .mockResolvedValueOnce({ data: "first", nextOffset: 5 })
    .mockResolvedValueOnce({ data: "again", nextOffset: 5 });
  await expect(
    openMessageSearch(
      view,
      "q",
      async () =>
        ({
          items: [{ seq: 7, role: "user", snippet: "q" }],
          nextBefore: null,
        }) as never,
      content,
    ),
  ).rejects.toThrow(/invalid message page/i);
  expect(content.mock.calls).toEqual([
    [{ seq: 7, field: "text", offset: 0, limit: 16000 }],
    [{ seq: 7, field: "text", offset: 5, limit: 16000 }],
  ]);
});
