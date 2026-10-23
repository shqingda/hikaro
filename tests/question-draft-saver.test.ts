import { expect, it, vi } from "vitest";
import { QuestionDraftSaver } from "../packages/tui/src/question-drafts.ts";
import type { QuestionDraft } from "../packages/protocol/src/contracts.ts";
const draft = (text: string): QuestionDraft => ({
  answers: { first: "Small" },
  inputs: { second: text },
  position: { kind: "input", questionId: "second" },
});
it("saves during continuous typing and serializes newer edits behind the current revision", async () => {
  vi.useFakeTimers();
  let release!: (value: { revision: number }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () => new Promise<{ revision: number }>((done) => (release = done)),
    )
    .mockResolvedValueOnce({ revision: 2 });
  const saver = new QuestionDraftSaver(
    { revision: 0, draft: null },
    save,
    vi.fn(),
  );
  try {
    saver.update(draft("a"));
    await vi.advanceTimersByTimeAsync(200);
    saver.update(draft("ab"));
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledExactlyOnceWith(0, draft("ab"));
    saver.update(draft("中文🌅"));
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    release({ revision: 1 });
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith(1, draft("中文🌅"));
    expect(saver.revision).toBe(2);
  } finally {
    saver.stop();
    vi.useRealTimers();
  }
});
it("keeps unsaved text on failure, retries only explicitly, and never overwrites a competing revision", async () => {
  vi.useFakeTimers();
  const error = vi.fn();
  const save = vi
    .fn()
    .mockRejectedValueOnce(Error("Disk unavailable"))
    .mockResolvedValueOnce({
      conflict: true,
      current: { revision: 2, draft: draft("other view") },
    });
  const saver = new QuestionDraftSaver(
    { revision: 1, draft: draft("old") },
    save,
    error,
  );
  try {
    saver.update(draft("unsaved"));
    await vi.advanceTimersByTimeAsync(300);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(saver.flush()).rejects.toThrow("another view");
    saver.update(draft("newer local edit"));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(saver.flush()).rejects.toThrow("reopen");
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.revision).toBe(1);
  } finally {
    saver.stop();
    vi.useRealTimers();
  }
});
it("drops pending writes when a panel is invalidated", async () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const saver = new QuestionDraftSaver(
    { revision: 0, draft: null },
    save,
    vi.fn(),
  );
  try {
    saver.update(draft("stale"));
    saver.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await saver.flush();
    saver.update(draft("late"));
    expect(save).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
