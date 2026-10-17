import { afterEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  TuiAltScreen,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import { HikaroView } from "../packages/tui/src/index.ts";
import type { PermissionRequest } from "../packages/core/src/types.ts";

const request: PermissionRequest = {
  id: "approval",
  sessionId: "session",
  tool: "read_file",
  arguments: { path: "/outside/README.md" },
  capability: { kind: "file", path: "/outside/README.md", write: false },
  reason: "Read /outside/README.md outside the workspace",
};

function fixture() {
  const terminal = {
    rows: 18,
    columns: 36,
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
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let input!: (data: string) => unknown;
  vi.spyOn(tui, "addInputListener").mockImplementation((listener) => {
    input = listener;
    return () => {};
  });
  const focus = vi.spyOn(tui, "setFocus");
  const view = new HikaroView(tui, {
    cwd: "/workspace",
    model: "fixture",
    onPrompt: async () => {},
    onCommand: async () => {},
    onExit: vi.fn(),
  });
  const screen = () =>
    stripVTControlCharacters(
      view.approvalSlot.render(terminal.columns).join("\n"),
    );
  return {
    view,
    terminal,
    input: (data: string) => input(data),
    focus,
    screen,
  };
}

afterEach(() => vi.useRealTimers());

describe("TUI approval panel", () => {
  it("approves the selected operation with arrow keys and preserves the draft", async () => {
    vi.useFakeTimers();
    const { view, input, focus, screen } = fixture();
    try {
      view.editor.setText("中文草稿🙂\nsecond line");
      const decided = vi.fn();
      const result = view
        .approve(request, new AbortController().signal)
        .then(decided);
      expect(screen()).toContain("Permission required");
      expect(screen()).toContain("read_file");
      expect(screen()).toContain("/outside/README.md");
      expect(screen()).toContain("→ Allow once");
      expect(screen()).not.toContain("Type allow");
      input("\r");
      await Promise.resolve();
      expect(decided).not.toHaveBeenCalled();
      vi.advanceTimersByTime(501);
      expect(input("allow")).toEqual({ consume: true });
      input("\x1b[B");
      expect(screen()).toContain("→ Deny");
      input("\x1b[A");
      input("\r");
      await result;
      expect(decided).toHaveBeenCalledExactlyOnceWith(true);
      expect(view.editor.getText()).toBe("中文草稿🙂\nsecond line");
      expect(view.approvalSlot.children).toHaveLength(0);
      expect(focus).toHaveBeenLastCalledWith(view.editor);
    } finally {
      view.dispose();
    }
  });

  it.each(["choice", "escape", "interrupt", "abort", "dispose", "rebind"])(
    "denies on %s, restores the draft, and settles only once",
    async (action) => {
      vi.useFakeTimers();
      const { view, input } = fixture();
      const abort = new AbortController();
      try {
        view.editor.setText("keep me");
        const decided = vi.fn();
        const result = view.approve(request, abort.signal).then(decided);
        vi.advanceTimersByTime(501);
        if (action === "choice") {
          input("\x1b[B");
          input("\r");
        } else if (action === "escape") input("\x1b");
        else if (action === "interrupt") input("\x03");
        else if (action === "abort") abort.abort();
        else if (action === "dispose") view.dispose();
        else
          view.bind({
            prompt: async () => {},
            cancel() {},
            steer() {},
            subscribe: () => () => {},
          });
        await result;
        abort.abort();
        expect(decided).toHaveBeenCalledExactlyOnceWith(false);
        expect(view.editor.getText()).toBe("keep me");
        expect(view.approvalSlot.children).toHaveLength(0);
      } finally {
        view.dispose();
      }
    },
  );

  it("keeps long details scrollable and controls visible when resized", async () => {
    const { view, terminal, input, screen } = fixture();
    const abort = new AbortController();
    try {
      const result = view.approve(
        {
          ...request,
          reason: Array.from(
            { length: 30 },
            (_, i) => `reason-line-${i} 中文🙂`,
          ).join("\n"),
        },
        abort.signal,
      );
      for (const width of [36, 60, 100]) {
        terminal.columns = width;
        const lines = view.approvalSlot.render(width);
        expect(lines.length).toBeLessThanOrEqual(12);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(screen()).toContain("Allow once");
        expect(screen()).toContain("Deny");
        expect(screen()).toContain("Esc");
      }
      for (let i = 0; i < 30; i++) input("\x1b[6~");
      expect(screen()).toContain("reason-line-29");
      input("\x1b[5~");
      expect(screen()).not.toContain("reason-line-29");
      terminal.rows = 7;
      expect(screen()).toContain("Resize");
      abort.abort();
      expect(await result).toBe(false);
    } finally {
      view.dispose();
    }
  });
});
