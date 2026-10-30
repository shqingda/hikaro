import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { ApprovalPanel } from "../packages/tui/src/approval-panel.ts";

const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

describe("workbench menus", () => {
  it("keeps choices to one line and pages the selected description independently", async () => {
    const panel = new ModelPanel(
      new AbortController().signal,
      () => {},
      () => 12,
    );
    const description = Array.from(
      { length: 24 },
      (_, i) => `detail-${i} 中文🙂`,
    ).join("\n");
    const choice = panel.choose(
      "Models",
      [
        { value: "a", label: "First model", description },
        { value: "b", label: "Second model", description: "Another model" },
      ],
      "",
      undefined,
      { search: false },
    );
    let lines = panel.render(40);
    expect(plain(lines)).toContain("First model");
    expect(plain(lines)).toContain("Second model");
    expect(plain(lines)).toContain("PgUp/PgDn");
    for (let i = 0; i < 30; i++) {
      panel.handleInput("\x1b[6~");
      lines = panel.render(40);
    }
    expect(plain(lines)).toContain("detail-23");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    panel.handleInput("\r");
    expect((await choice).value).toBe("a");
  });

  it("shows a bounded list with the selected item at every supported width", async () => {
    const panel = new ModelPanel(
      new AbortController().signal,
      () => {},
      () => 18,
    );
    const choice = panel.choose(
      "Sessions",
      Array.from({ length: 20 }, (_, i) => ({
        value: String(i),
        label: `Session ${i}`,
        description: `State ${i}`,
      })),
      "",
      undefined,
      { search: false, selectedValue: "19" },
    );
    for (const width of [40, 60, 80, 120]) {
      const lines = panel.render(width);
      expect(plain(lines)).toContain("→ Session 19");
      expect(
        plain(lines)
          .split("\n")
          .filter((line) => /Session \d/.test(line)).length,
      ).toBeLessThanOrEqual(8);
      expect(lines.length).toBeLessThanOrEqual(18);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    expect((await choice).value).toBe("0");
  });

  it("labels async search and never confirms a stale result", async () => {
    let resolve!: (items: Array<{ value: string; label: string }>) => void;
    const panel = new ModelPanel(new AbortController().signal, () => {});
    const done = vi.fn();
    const choice = panel
      .choose(
        "Sessions",
        [{ value: "old", label: "Old session" }],
        "",
        undefined,
        {
          search: true,
          loadItems: () =>
            new Promise((yes) => {
              resolve = yes;
            }),
        },
      )
      .then(done);
    panel.handleInput("new");
    expect(plain(panel.render(80))).toContain("Searching…");
    panel.handleInput("\r");
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    resolve([{ value: "new", label: "New session" }]);
    await Promise.resolve();
    panel.handleInput("\r");
    await choice;
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ value: "new", query: "new" }),
    );
  });

  it("starts permission selection on Deny and refuses unreadable approval", () => {
    vi.useFakeTimers();
    try {
      let budget = 12;
      const answer = vi.fn();
      const panel = new ApprovalPanel(
        {
          id: "a",
          sessionId: "s",
          tool: "read_file",
          arguments: { path: "/tmp/file" },
          reason: "Read file",
        },
        "/tmp",
        answer,
        () => {},
        () => budget,
      );
      expect(plain(panel.render(80))).toContain("→ Deny");
      panel.handleInput("\r");
      expect(answer).not.toHaveBeenCalled();
      vi.advanceTimersByTime(501);
      panel.handleInput("\r");
      expect(answer).toHaveBeenCalledWith(false);
      answer.mockClear();
      budget = 3;
      expect(plain(panel.render(40))).toContain("Resize");
      panel.handleInput("\x1b[A");
      panel.handleInput("\r");
      expect(answer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
