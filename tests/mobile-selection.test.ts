import { describe, it, expect } from "vitest";
import { selectionSnapshot } from "../apps/mobile/src/selection.ts";

describe("mobile state selection", () => {
  it("keeps the selected snapshot while unrelated fields change", () => {
    let state = { stream: "", busy: false, canSend: true, phase: "connected" };
    const snapshot = selectionSnapshot(
      () => state,
      (s) => ({ busy: s.busy, canSend: s.canSend, phase: s.phase }),
    );
    const first = snapshot();
    for (const stream of ["a", "ab", "abc"]) {
      state = { ...state, stream };
      expect(snapshot()).toBe(first);
    }
    state = { ...state, busy: true };
    const second = snapshot();
    expect(second).not.toBe(first);
    expect(second.busy).toBe(true);
    expect(snapshot()).toBe(second);
  });

  it("compares selected values by identity, not deep equality", () => {
    let state = { messages: [1, 2] };
    const snapshot = selectionSnapshot(
      () => state,
      (s) => ({ messages: s.messages }),
    );
    const first = snapshot();
    state = { messages: [1, 2] };
    expect(snapshot()).not.toBe(first);
  });
});
