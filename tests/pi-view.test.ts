import { describe, it, expect, vi } from "vitest";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { sanitize } from "../packages/tui/src/text.ts";
import { PiBridgeView } from "../packages/pi-bridge/src/view.ts";
import type { PiTransport } from "../packages/pi-bridge/src/index.ts";
import type { ModelPickerCatalog } from "../packages/tui/src/model-picker.ts";
import { MessageComponent } from "../packages/tui/src/messages.ts";

class FakeHikaro implements PiTransport {
  calls: Array<{ method: string; params?: any }> = [];
  exits = new Set<(e: Error) => void>();
  handler: (method: string, params?: any) => Promise<any> = async (m) =>
    m === "session.create" || m === "session.resume"
      ? { id: "new-session" }
      : m === "messages.read"
        ? { items: [] }
        : {};
  listeners = new Set<(m: any) => void>();
  subscribe(f: (m: any) => void) {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }
  emit(m: any) {
    for (const f of this.listeners) f(m);
  }
  onExit(f: (e: Error) => void) {
    this.exits.add(f);
    return () => {
      this.exits.delete(f);
    };
  }
  request(method: string, params?: any) {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
  async send() {}
  async close() {}
  crash() {
    for (const f of this.exits) f(Error("Agent process exited (SIGKILL)"));
  }
}
const tui: any = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
const settle = () => new Promise((r) => setTimeout(r, 0));
const screen = (view: PiBridgeView) => sanitize(view.render(80).join("\n"));
const type = (view: PiBridgeView, text: string) => {
  for (const ch of text) view.handleInput(ch);
  view.handleInput("\r");
};

describe("Pi bridge view", () => {
  it("uses shared Markdown rendering and preserves completed message components while streaming", async () => {
    const client = new FakeHikaro();
    client.handler = async (method) =>
      method === "messages.read"
        ? {
            items: [
              { message: { role: "user", text: "Earlier **question**" } },
            ],
          }
        : { id: "embedded" };
    const rendered = vi.spyOn(MessageComponent.prototype, "render");
    const view = new PiBridgeView(tui, client, () => {}, {
      resumeSessionId: "embedded",
    });
    try {
      await settle();
      expect(screen(view)).toContain("Earlier question");
      expect(screen(view)).not.toContain("**question**");
      const history = rendered.mock.contexts.find(
        (item) => item instanceof MessageComponent && item.role === "user",
      )!;
      expect(history).toBeDefined();
      const first =
        rendered.mock.results[rendered.mock.contexts.indexOf(history)]!.value;
      client.emit({ type: "event", event: { type: "run.start", data: {} } });
      client.emit({
        type: "event",
        event: {
          type: "text.delta",
          data: { text: "This is **offline demo mode**." },
        },
      });
      expect(screen(view)).toContain("offline demo mode");
      expect(screen(view)).not.toContain("**offline demo mode**");
      client.emit({
        type: "event",
        event: { type: "text.delta", data: { text: "\n\n- 中文 result" } },
      });
      screen(view);
      const completed = rendered.mock.contexts.flatMap((item, index) =>
        item === history ? [rendered.mock.results[index]!.value] : [],
      );
      expect(completed.every((lines) => lines === first)).toBe(true);
      expect(
        new Set(
          rendered.mock.contexts.filter(
            (item) => item instanceof MessageComponent && item.role === "user",
          ),
        ).size,
      ).toBe(1);
    } finally {
      view.dispose();
      rendered.mockRestore();
    }
  });

  it("opens retained long-message parts in the shared searchable reader", async () => {
    const client = new FakeHikaro();
    const view = new PiBridgeView(tui, client, () => {});
    try {
      await settle();
      client.emit({ type: "event", event: { type: "run.start", data: {} } });
      client.emit({
        type: "event",
        event: {
          type: "text.delta",
          data: { text: "x".repeat(16_000) + "\nneedle on next part" },
        },
      });
      client.emit({
        type: "event",
        event: { type: "run.end", data: { status: "completed" } },
      });
      expect(screen(view)).toContain("/read 1 PART");
      type(view, "/read 1 2");
      await vi.waitFor(() =>
        expect(screen(view)).toContain("needle on next part"),
      );
      view.handleInput("/");
      view.handleInput("needle");
      expect(screen(view)).toContain("Match 1/1");
      view.handleInput("\x1b");
      view.handleInput("\x1b");
      await vi.waitFor(() => expect(screen(view)).toContain("Enter send"));
      expect(client.calls.some((call) => call.method === "prompt")).toBe(false);
    } finally {
      view.dispose();
    }
  });
  it("uses the shared workspace views and model center without submitting model commands as prompts", async () => {
    const client = new FakeHikaro();
    client.handler = async (method) =>
      method === "session.create"
        ? { id: "embedded" }
        : method === "models.list"
          ? {
              items: [{ provider: "test", id: "alpha", name: "Alpha" }],
              hasMore: false,
            }
          : {};
    const catalog: ModelPickerCatalog = {
      available: async () => [{ provider: "test", id: "alpha", name: "Alpha" }],
      providers: async () => [],
      login: vi.fn(async () => {}),
      refresh: async () => undefined,
    };
    const view = new PiBridgeView(tui, client, () => {}, {
      modelCatalog: catalog,
      cwd: "/workspace",
    });
    await settle();
    expect(screen(view)).toContain("Conversation");
    expect(screen(view)).toContain("Activity");
    expect(screen(view)).not.toContain("Changes");
    type(view, "/model");
    await vi.waitFor(() => expect(screen(view)).toContain("Alpha"));
    view.handleInput("\r");
    await vi.waitFor(() =>
      expect(client.calls.some((call) => call.method === "model.set")).toBe(
        true,
      ),
    );
    expect(
      client.calls.find((call) => call.method === "model.set")?.params,
    ).toMatchObject({
      sessionId: "embedded",
      provider: "test",
      model: "alpha",
    });
    expect(client.calls.some((call) => call.method === "prompt")).toBe(false);
    view.dispose();
  });
  it("resumes the saved session and shows its recent messages", async () => {
    const client = new FakeHikaro();
    client.handler = async (m, p) =>
      m === "session.resume"
        ? { id: p.sessionId }
        : m === "messages.read"
          ? {
              items: [
                { seq: 1, message: { role: "user", text: "earlier question" } },
                {
                  seq: 2,
                  message: { role: "assistant", text: "earlier answer" },
                },
              ],
            }
          : {};
    const saved: string[] = [];
    const view = new PiBridgeView(tui, client, () => {}, {
      resumeSessionId: "s-1",
      onSession: (id) => saved.push(id),
    });
    await settle();
    await settle();
    expect(client.calls.map((c) => c.method)).toEqual([
      "session.resume",
      "messages.read",
    ]);
    expect(client.calls[0]?.params).toEqual({ sessionId: "s-1" });
    expect(screen(view)).toMatch(/YOU\s+earlier question/);
    expect(screen(view)).toMatch(/HIKARO\s+earlier answer/);
    expect(screen(view)).toContain("earlier answer");
    expect(saved).toEqual(["s-1"]);
  });

  it("falls back to a new session when the saved one cannot be resumed", async () => {
    const client = new FakeHikaro();
    client.handler = async (m) => {
      if (m === "session.resume") throw Error("Session not found");
      return m === "session.create" ? { id: "fresh" } : {};
    };
    const saved: string[] = [];
    new PiBridgeView(tui, client, () => {}, {
      resumeSessionId: "gone",
      onSession: (id) => saved.push(id),
    });
    await settle();
    await settle();
    expect(client.calls.map((c) => c.method)).toEqual([
      "session.resume",
      "session.create",
    ]);
    expect(saved).toEqual(["fresh"]);
  });

  it("returns to Pi with /back or Ctrl+D after Hikaro disconnects, keeping the draft", async () => {
    for (const leave of ["/back", "\x04"]) {
      const client = new FakeHikaro();
      let done = 0;
      const view = new PiBridgeView(tui, client, () => done++);
      await settle();
      client.crash();
      type(view, "unsent draft");
      expect(screen(view)).toContain("not connected");
      expect(view.editor.getText()).toBe("unsent draft");
      if (leave === "/back") type(view, leave);
      else view.handleInput(leave);
      expect(done).toBe(1);
    }
  });

  it("returns a disconnected unsent draft to the extension and restores it on reentry", async () => {
    const client = new FakeHikaro();
    let draft = "";
    const view = new PiBridgeView(tui, client, () => {}, {
      onDraft: (text) => {
        draft = text;
      },
    });
    await settle();
    client.crash();
    type(view, "unsent context");
    type(view, "/back");
    expect(draft).toBe("unsent context");
    const next = new PiBridgeView(tui, new FakeHikaro(), () => {}, { draft });
    expect(next.editor.getText()).toBe("unsent context");
    next.dispose();
  });

  it("shows a rejected prompt instead of staying busy", async () => {
    const client = new FakeHikaro();
    client.handler = async (m) =>
      m === "session.create" ? { id: "s" } : { accepted: true };
    const view = new PiBridgeView(tui, client, () => {});
    await settle();
    type(view, "hello");
    await settle();
    expect(screen(view)).toContain("Working");
    client.emit({
      type: "error",
      error: "Error: Session is running elsewhere",
    });
    expect(screen(view)).toContain("Session is running elsewhere");
    expect(screen(view)).not.toContain("Working");
  });
});

it("shows connection and terminal outcomes without inventing Ready", async () => {
  const client = new FakeHikaro();
  let connect!: (value: unknown) => void;
  client.handler = () =>
    new Promise((resolve) => {
      connect = resolve;
    });
  const view = new PiBridgeView(tui, client, () => {});
  expect(screen(view)).toContain("Connecting");
  expect(screen(view)).not.toContain("Ready");
  connect({ id: "s" });
  await settle();
  expect(screen(view)).toContain("Ready");
  client.emit({ type: "event", event: { type: "run.start", data: {} } });
  client.emit({
    type: "event",
    event: { type: "run.end", data: { status: "cancelled" } },
  });
  expect(screen(view).split("\n").at(-1)).toContain("Stopped");
  client.crash();
  expect(screen(view)).toContain("Disconnected");
  expect(screen(view)).toContain("/back");
  view.dispose();
});

it("renders one assistant label per streamed message and updates tool summaries in place", async () => {
  const client = new FakeHikaro();
  const view = new PiBridgeView(tui, client, () => {});
  await settle();
  const emit = (type: string, data: any) =>
    client.emit({ type: "event", event: { type, data } });
  emit("run.start", {});
  emit("text.delta", { text: "Checking " });
  emit("text.delta", { text: "the source." });
  emit("tool.start", {
    callId: "read-1",
    name: "read_file",
    arguments: { path: "src/auth.ts" },
  });
  expect(screen(view)).toContain("Running");
  expect(screen(view)).toContain("src/auth.ts");
  emit("tool.end", {
    callId: "read-1",
    name: "read_file",
    result: { text: "contents" },
  });
  const rendered = screen(view);
  expect(rendered.match(/HIKARO/g)).toHaveLength(1);
  expect(rendered.match(/src\/auth.ts/g)).toHaveLength(1);
  expect(rendered).toMatch(/Done\s+read_file\s+src\/auth.ts/);
  expect(rendered).not.toContain("contents");
  view.dispose();
});

it.each([
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
])(
  "keeps the editor horizon and return action in %s×%s",
  async (columns, rows) => {
    const client = new FakeHikaro();
    const localTui = { ...tui, terminal: { rows, columns } };
    const view = new PiBridgeView(localTui, client, () => {});
    await settle();
    const lines = view.render(columns).map(sanitize);
    expect(lines).toHaveLength(rows);
    expect(lines.filter((line) => line.includes("─"))).toHaveLength(1);
    expect(lines.join("\n")).toContain("Message");
    expect(lines.join("\n")).toContain("/back");
    expect(lines.at(-1)).toContain("Ready");
    view.dispose();
  },
);

it("keeps a failed connection failed when its pending handshake completes", async () => {
  const client = new FakeHikaro();
  let connect!: (value: unknown) => void;
  client.handler = () =>
    new Promise((resolve) => {
      connect = resolve;
    });
  const view = new PiBridgeView(tui, client, () => {});
  client.crash();
  connect({ id: "s" });
  await settle();
  expect(screen(view)).toContain("Disconnected");
  expect(screen(view)).not.toContain("Ready");
  view.dispose();
});

it.each([
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
])(
  "preserves the cursor and mouse mapping for long drafts in %s×%s",
  async (columns, rows) => {
    const client = new FakeHikaro();
    const localTui = { ...tui, terminal: { rows, columns } };
    const view = new PiBridgeView(localTui, client, () => {});
    await settle();
    view.focused = true;
    view.editor.setText(
      Array.from({ length: 40 }, (_, i) => `line ${i} 中文🙂`).join("\n"),
    );
    const lines = view.render(columns);
    expect(lines).toHaveLength(rows);
    expect(lines.join("\n")).toContain(CURSOR_MARKER);
    expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const editorX = columns >= 100 ? 23 : 0;
    view.handleMouse({
      type: "click",
      button: "left",
      x: editorX + 1,
      y: cursorRow,
      screenX: editorX + 1,
      screenY: cursorRow,
      width: columns,
      height: rows,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(view.editor.getCursor()).toEqual({ line: 39, col: 0 });
    view.handleInput("X");
    expect(view.editor.getText().split("\n").at(-1)).toBe("Xline 39 中文🙂");
    view.dispose();
  },
);

it("uses terminal color changes without delaying connection and respects NO_COLOR", async () => {
  vi.stubEnv("NO_COLOR", undefined);
  const client = new FakeHikaro();
  let onScheme!: (scheme: "light" | "dark") => void;
  const unsubscribe = vi.fn();
  const localTui = {
    ...tui,
    onTerminalColorSchemeChange(callback: typeof onScheme) {
      onScheme = callback;
      return unsubscribe;
    },
    queryTerminalColors() {
      return new Promise(() => {});
    },
  };
  const view = new PiBridgeView(localTui as any, client, () => {});
  await settle();
  expect(screen(view)).toContain("Ready");
  onScheme("light");
  expect(view.render(80).join("\n")).toContain("38;2;107;80;0");
  onScheme("dark");
  expect(view.render(80).join("\n")).toContain("38;2;242;181;0");
  vi.stubEnv("NO_COLOR", "1");
  try {
    view.invalidate();
    expect(view.render(80).join("\n")).not.toMatch(/\x1b\[[0-9;]*m/);
  } finally {
    vi.unstubAllEnvs();
    view.dispose();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps cancelled tool results Stopped and uses the supplied file_path target", async () => {
  const client = new FakeHikaro();
  const view = new PiBridgeView(tui, client, () => {});
  await settle();
  const emit = (type: string, data: any) =>
    client.emit({ type: "event", event: { type, data } });
  emit("run.start", {});
  emit("tool.start", {
    callId: "read-cancelled",
    name: "read_file",
    arguments: { file_path: "src/cancelled.ts" },
  });
  expect(screen(view)).toMatch(/Running\s+read_file\s+src\/cancelled.ts/);
  emit("tool.end", {
    callId: "read-cancelled",
    name: "read_file",
    status: "cancelled",
    result: { text: "Operation cancelled", isError: true },
  });
  emit("run.end", { status: "cancelled" });
  expect(screen(view)).toMatch(/Stopped\s+read_file\s+src\/cancelled.ts/);
  expect(screen(view)).not.toContain("Failed");
  view.dispose();
});
