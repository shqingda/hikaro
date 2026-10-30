import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  TuiAltScreen,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import { HikaroView } from "../packages/tui/src/index.ts";
import { defaultTuiPreferences } from "../packages/tui/src/preferences.ts";
import type { AgentBackend } from "../packages/core/src/types.ts";

function fixture(columns = 80, rows = 24) {
  const terminal: Terminal = {
    columns,
    rows,
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
  const view = new HikaroView(tui, {
    cwd: "/tmp/hikaro",
    model: "test-model",
    onPrompt: async () => {},
    onCommand: async () => {},
    onExit() {},
  });
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    view.event({
      type,
      data,
      seq: ++seq,
      sessionId: "fixture",
      timestamp: seq,
    });
  return {
    view,
    event,
    screen: () =>
      stripVTControlCharacters(
        renderLayoutFrame(view.layout, columns, rows, () => {}).lines.join(
          "\n",
        ),
      ),
  };
}

it("keeps completed tool summaries and expands their already received result", () => {
  const { view, event, screen } = fixture();
  try {
    event("tool.start", {
      callId: "a",
      name: "read_file",
      arguments: { path: "src/a.ts" },
    });
    event("tool.start", {
      callId: "b",
      name: "shell",
      arguments: { command: "pnpm test" },
    });
    event("tool.end", {
      callId: "a",
      name: "read_file",
      result: { text: "PRIVATE DETAIL" },
    });
    expect(screen()).toMatch(/Done[^\n]*read_file[^\n]*src\/a.ts/);
    expect(screen()).toMatch(/Running[^\n]*shell[^\n]*pnpm test/);
    expect(screen()).not.toContain("PRIVATE DETAIL");
    view.setPreferences({ ...defaultTuiPreferences, showToolDetails: true });
    expect(screen()).toContain("PRIVATE DETAIL");
    view.setPreferences(defaultTuiPreferences);
    expect(screen()).not.toContain("PRIVATE DETAIL");
    event("tool.end", {
      callId: "b",
      name: "shell",
      result: { text: "test failed", isError: true },
    });
    expect(screen()).toMatch(/Failed[^\n]*shell/);
    expect(screen()).toContain("test failed");
  } finally {
    view.dispose();
  }
});

it.each([
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
])("keeps status and permissions visible at %s x %s", (cols, rows) => {
  const { view, screen } = fixture(cols, rows);
  try {
    view.setStatus({
      connection: "disconnected",
      permission: "Full Access",
      model: "very-long-provider/model-name",
    });
    view.setPreferences({ ...defaultTuiPreferences, showUsage: false });
    expect(screen()).toContain("Disconnected");
    expect(screen()).toContain("Full Access");
    const lines = renderLayoutFrame(view.layout, cols, rows, () => {}).lines;
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.every((line) => visibleWidth(line) <= cols)).toBe(true);
  } finally {
    view.dispose();
  }
});

it("reconstructs history summaries without inventing missing targets", () => {
  const { view, screen } = fixture();
  try {
    view.showMessages([
      { role: "user", text: "Read it", timestamp: 1 },
      {
        role: "assistant",
        text: "",
        timestamp: 2,
        toolCalls: [
          { id: "a", name: "read_file", arguments: { path: "src/a.ts" } },
        ],
      },
      {
        role: "tool",
        callId: "a",
        name: "read_file",
        text: "body",
        timestamp: 3,
      },
      {
        role: "tool",
        callId: "b",
        name: "shell",
        text: "failure",
        isError: true,
        timestamp: 4,
      },
    ]);
    expect(screen()).toContain("YOU");
    expect(screen()).toMatch(/Done[^\n]*read_file[^\n]*src\/a.ts/);
    expect(screen()).toMatch(/Failed[^\n]*shell/);
    expect(screen()).not.toContain("undefined");
  } finally {
    view.dispose();
  }
});

it("resets a previous failure when binding a new session", () => {
  const { view, event } = fixture();
  try {
    event("run.end", { status: "failed", error: "old failure" });
    view.bind({ subscribe: () => () => {} } as unknown as AgentBackend);
    view.showMessages([]);
    expect(view.footer.render(80).join("\n")).toContain("Ready");
    expect(view.inputError.render(80).join("\n")).not.toContain("old failure");
  } finally {
    view.dispose();
  }
});

it("updates activity without appending tools while reading older history", () => {
  const { view, event } = fixture();
  try {
    view.showMessages([{ role: "user", text: "older", timestamp: 1 }], {
      hasNewer: true,
    });
    event("run.start", {});
    event("tool.start", {
      callId: "a",
      name: "shell",
      arguments: { command: "pwd" },
    });
    expect(view.footer.render(80).join("\n")).toContain("Running shell");
    expect(view.content.render(80).join("\n")).not.toContain("pwd");
    event("tool.end", { callId: "a", name: "shell", result: { text: "done" } });
    expect(view.footer.render(80).join("\n")).toContain("Working");
  } finally {
    view.dispose();
  }
});

it("keeps failure and permissions visible beside a long error in a short terminal", () => {
  const { view, screen } = fixture(40, 12);
  try {
    view.setPermissionLabel("Full Access");
    view.setError("Provider error\n" + "details here\n".repeat(25));
    expect(screen()).toContain("Failed");
    expect(screen()).toContain("Full Access");
    expect(view.content.render(40).join("\n")).toContain("Provider error");
  } finally {
    view.dispose();
  }
});

it("shows one manual tool result and keeps its output when detail preferences change", () => {
  const { view, event, screen } = fixture();
  try {
    event("tool.start", {
      callId: "shell1",
      name: "shell",
      arguments: { command: "pwd" },
    });
    event("tool.end", {
      callId: "shell1",
      name: "shell",
      result: { text: "manual-output" },
    });
    event("message", {
      message: {
        role: "tool",
        callId: "shell1",
        name: "shell",
        source: "manual",
        text: "manual-output",
        timestamp: 1,
      },
    });
    expect(screen().match(/Done  shell/g)).toHaveLength(1);
    view.setPreferences(defaultTuiPreferences);
    expect(screen()).toContain("manual-output");
  } finally {
    view.dispose();
  }
});

it("preserves a cancelled tool's status when its saved manual result arrives", () => {
  const { view, event, screen } = fixture();
  try {
    event("tool.start", {
      callId: "cancelled",
      name: "shell",
      arguments: { command: "sleep 60" },
    });
    event("tool.end", {
      callId: "cancelled",
      name: "shell",
      status: "cancelled",
      result: { text: "aborted", isError: true },
    });
    event("message", {
      message: {
        role: "tool",
        callId: "cancelled",
        name: "shell",
        source: "manual",
        text: "aborted",
        isError: true,
        timestamp: 1,
      },
    });
    expect(screen()).toContain("Stopped  shell");
    expect(screen()).not.toContain("Failed  shell");
    expect(screen()).toContain("aborted");
  } finally {
    view.dispose();
  }
});
