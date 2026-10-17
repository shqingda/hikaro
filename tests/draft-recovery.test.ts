import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftSaver } from "../packages/tui/src/drafts.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
afterEach(() => vi.useRealTimers());

it("preserves live edits when the current session is rebound during a pending save", async () => {
  const persisted = new Map([["a", "Earlier saved draft"]]);
  let release!: () => void;
  let first = true;
  const saver = new DraftSaver(async (id, text) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    persisted.set(id, text);
  }, vi.fn());
  saver.update("a", "Editing before model change");
  const writing = saver.flush();
  const read = vi.fn(async (id: string) => persisted.get(id) ?? "");
  const restored = saver.restore("a", "a", read);
  let editor = "New typing while the model is changing";
  saver.update("a", editor);
  release();
  const text = await restored;
  if (text !== undefined) editor = text;
  await writing;
  expect(editor).toBe("New typing while the model is changing");
  expect(persisted.get("a")).toBe(editor);
  expect(read).not.toHaveBeenCalled();
});

it("restores a different session only after pending outgoing edits are durable", async () => {
  const persisted = new Map([["b", "Destination draft"]]);
  let release!: () => void;
  const saver = new DraftSaver(async (id, text) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    persisted.set(id, text);
  }, vi.fn());
  saver.update("a", "Outgoing draft");
  const writing = saver.flush();
  let completed = false;
  const restored = saver
    .restore("a", "b", async (id) => persisted.get(id) ?? "")
    .then((text) => {
      completed = true;
      return text;
    });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  expect(await restored).toBe("Destination draft");
  await writing;
  expect(persisted.get("a")).toBe("Outgoing draft");
});

it("does not strand an edit arriving during an empty flush", async () => {
  vi.useFakeTimers();
  let saved = "";
  const saver = new DraftSaver(async (_id, text) => {
    saved = text;
  }, vi.fn());
  const empty = saver.flush();
  saver.update("a", "typed during flush");
  await empty;
  await vi.advanceTimersByTimeAsync(300);
  expect(saved).toBe("typed during flush");
});

it("autosaves continuous typing within a bounded interval and restores from another connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hikaro-draft-"));
  const store = await SQLiteStore.open(join(dir, "test.sqlite"));
  try {
    const session = await store.createSession("/work");
    vi.useFakeTimers();
    const saver = new DraftSaver(
      (id, text) => store.saveDraft(id, text),
      (error) => {
        throw error;
      },
    );
    saver.update(session.id, "草");
    await vi.advanceTimersByTimeAsync(200);
    saver.update(session.id, "草稿🙂");
    await vi.advanceTimersByTimeAsync(100);
    await saver.flush();
    const recovered = await SQLiteStore.open(join(dir, "test.sqlite"));
    try {
      expect(await recovered.draft(session.id)).toBe("草稿🙂");
    } finally {
      await recovered.close();
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("serializes clears after in-flight writes and keeps session drafts separate", async () => {
  vi.useFakeTimers();
  const saved = new Map<string, string>();
  let release!: () => void;
  let first = true;
  const saver = new DraftSaver(async (id, text) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    saved.set(id, text);
  }, vi.fn());
  saver.update("a", "old draft");
  await vi.advanceTimersByTimeAsync(300);
  saver.update("a", "");
  saver.update("b", "new session draft");
  const flushed = saver.flush();
  release();
  await flushed;
  expect([...saved]).toEqual([
    ["a", ""],
    ["b", "new session draft"],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports persistence failures and retries the latest text on the next edit", async () => {
  vi.useFakeTimers();
  let fail = true;
  let saved = "";
  const error = vi.fn();
  const saver = new DraftSaver(async (_id, text) => {
    if (fail) throw Error("Disk full");
    saved = text;
  }, error);
  saver.update("a", "first");
  await vi.advanceTimersByTimeAsync(300);
  expect(error).toHaveBeenCalledOnce();
  fail = false;
  saver.update("a", "latest");
  await saver.flush();
  expect(saved).toBe("latest");
  expect(vi.getTimerCount()).toBe(0);
});
