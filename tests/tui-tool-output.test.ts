import { expect, it, vi } from "vitest";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { HikaroView, MessageComponent } from "../packages/tui/src/index.ts";
import { defaultTuiPreferences } from "../packages/tui/src/preferences.ts";
import { sanitize } from "../packages/tui/src/text.ts";
import type { Message } from "../packages/core/src/types.ts";

function fixture(showToolDetails = true) {
  const terminal: Terminal = {
    rows: 30,
    columns: 100,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const prompt = vi.fn(async () => {});
  const view = new HikaroView(tui, {
    cwd: "/tmp",
    model: "fixture",
    onPrompt: prompt,
    onCommand: async () => {},
    onExit() {},
  });
  view.setPreferences({ ...defaultTuiPreferences, showToolDetails });
  const screen = () =>
    sanitize(view.content.render(100).join("\n"))
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
  const read = (part: number) => {
    view.editor.setText(`/read 1 ${part}`);
    view.editor.handleInput("\r");
    return screen();
  };
  return { view, prompt, screen, read };
}

const output =
  "**literal tool output**\n" +
  "long output\n".repeat(2000) +
  "\n[Output truncated; complete result: /tmp/tool-result.json]";

it.each(["history", "live", "manual"] as const)(
  "reads the entire %s tool result in bounded plain-text pages",
  (source) => {
    const { view, prompt, screen, read } = fixture(source !== "manual");
    const message: Message = {
      role: "tool",
      name: "shell",
      text: output,
      timestamp: 1,
      ...(source === "manual" ? { source: "manual" } : {}),
    };
    try {
      if (source === "history") view.showMessages([message]);
      else
        view.event({
          sessionId: "fixture",
          seq: 1,
          timestamp: 1,
          type: source === "manual" ? "message" : "tool.end",
          data:
            source === "manual"
              ? { message }
              : { name: "shell", result: { text: output } },
        });
      expect(screen()).toContain("**literal tool output**");
      expect(screen()).toContain("Message 1 · part 1/2 · /read 1 PART");
      expect(screen()).not.toContain("complete result:");
      expect(screen().length).toBeLessThan(18000);
      expect(read(2)).toContain(
        "[Output truncated; complete result: /tmp/tool-result.json]",
      );
      expect(read(1)).toContain("**literal tool output**");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  },
);

it("keeps failed tool output readable and hides ordinary tool details by default", () => {
  const { view, screen } = fixture(false);
  try {
    view.event({
      type: "tool.end",
      sessionId: "fixture",
      seq: 1,
      timestamp: 1,
      data: {
        name: "shell",
        result: { text: "permission denied", isError: true },
      },
    });
    expect(screen()).toContain("permission denied");
    expect(screen()).toContain("Failed  shell");
    view.setPreferences({ ...defaultTuiPreferences, showToolDetails: true });
    view.showMessages([
      {
        role: "tool",
        name: "shell",
        isError: true,
        text: "permission denied",
        timestamp: 1,
      },
    ]);
    expect(screen()).toContain("Failed  shell");
    expect(screen()).toContain("permission denied");
  } finally {
    view.dispose();
  }
});

it("loads only the requested remote page and ignores a late earlier page", async () => {
  const pending = new Map<number, (text: string) => void>();
  const read = vi.fn(
    (offset: number) =>
      new Promise<string>((resolve) => pending.set(offset, resolve)),
  );
  const message = new MessageComponent(1, "tool", "PREVIEW", false, {
    textLength: 48000,
    read,
  });
  const screen = () => sanitize(message.render(100).join("\n"));
  expect(screen()).toContain("part 1/3");
  expect(read).not.toHaveBeenCalled();
  const earlier = message.selectPage(1);
  const later = message.selectPage(2);
  expect(read.mock.calls).toEqual([
    [16000, 16000],
    [32000, 16000],
  ]);
  pending.get(32000)!("LATEST-PAGE\x1b[2J");
  await later;
  pending.get(16000)!("STALE-PAGE");
  await earlier;
  expect(screen()).toContain("LATEST-PAGE");
  expect(screen()).toContain("part 3/3");
  expect(screen()).not.toContain("STALE-PAGE");
  expect(message.render(100).join("\n")).not.toContain("\x1b[2J");
});

it("keeps the last readable page when a remote read fails", async () => {
  const message = new MessageComponent(1, "tool", "READABLE-PREVIEW", false, {
    textLength: 48000,
    read: async () => {
      throw Error("Host disconnected");
    },
  });
  await expect(message.selectPage(2)).rejects.toThrow("Host disconnected");
  const screen = sanitize(message.render(100).join("\n"));
  expect(screen).toContain("READABLE-PREVIEW");
  expect(screen).toContain("part 1/3");
});

it("preserves the complete-result path supplied separately from a bounded live result", () => {
  const { view, read } = fixture();
  try {
    view.event({
      type: "tool.end",
      sessionId: "fixture",
      seq: 1,
      timestamp: 1,
      data: {
        name: "shell",
        result: {
          text: "a".repeat(48000),
          data: { artifact: "/tmp/full-result.json" },
        },
      },
    });
    expect(read(4)).toContain("/tmp/full-result.json");
  } finally {
    view.dispose();
  }
});
