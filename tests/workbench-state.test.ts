import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { HikaroView } from "../packages/tui/src/index.ts";
import {
  ObjectPage,
  type ObjectDetail,
} from "../packages/tui/src/object-page.ts";
import { AttachmentStrip } from "../packages/tui/src/attachment-strip.ts";

function fixture() {
  const tui = new TuiAltScreen({
    rows: 24,
    columns: 80,
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
  } satisfies Terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let input!: (data: string) => { consume?: boolean } | undefined;
  vi.spyOn(tui, "addInputListener").mockImplementation((listener) => {
    input = listener as typeof input;
    return () => {};
  });
  const steer = vi.fn(async (_text: string, _runId?: string) => {});
  const prompt = vi.fn(async (_text: string) => {});
  const view = new HikaroView(tui, {
    cwd: "/tmp",
    model: "fixture",
    onPrompt: prompt,
    onSteer: steer,
    onCommand: async () => {},
    onExit() {},
  });
  tui.setFocus(view.editor);
  const key = (data: string) => {
    if (!input(data)?.consume) tui.getFocusedComponent()?.handleInput?.(data);
  };
  const event = (type: string, data: Record<string, unknown> = {}) =>
    view.event({ type, data, sessionId: "a", seq: 1, timestamp: 1 });
  return { tui, view, key, steer, prompt, event };
}

describe("workbench session ownership", () => {
  it("retains a hidden approval without changing the foreground focus or deciding it", async () => {
    const { tui, view, key } = fixture();
    view.editor.setText("saved draft");
    view.setActive(false);
    const other = { render: () => ["B"], invalidate() {} };
    tui.setFocus(other);
    const decided = vi.fn();
    const work = view
      .approve(
        {
          id: "permission",
          sessionId: "a",
          tool: "shell",
          reason: "Run test",
          arguments: { command: "true" },
        },
        new AbortController().signal,
      )
      .then(decided);
    expect(tui.getFocusedComponent()).toBe(other);
    expect(view.attentionCount).toBe(1);
    expect(decided).not.toHaveBeenCalled();
    view.setActive(true);
    expect(view.editor.getExpandedText()).toBe("saved draft");
    expect(tui.getFocusedComponent()).not.toBe(other);
    key("\x1b");
    await work;
    expect(decided).toHaveBeenCalledExactlyOnceWith(false);
    view.dispose();
  });
  it("binds Enter to the observed run and makes queue a distinct one-shot operation", async () => {
    const { view, key, event, steer, prompt } = fixture();
    try {
      event("run.start", { runId: "run-a" });
      view.editor.setText("adjust this run");
      key("\r");
      await vi.waitFor(() =>
        expect(steer).toHaveBeenCalledExactlyOnceWith(
          "adjust this run",
          "run-a",
        ),
      );
      view.editor.setText("next task");
      key("\x18");
      key("\r");
      await vi.waitFor(() =>
        expect(prompt).toHaveBeenCalledExactlyOnceWith(
          "next task",
          undefined,
          undefined,
        ),
      );
      await Promise.resolve();
      view.editor.setText("one more adjustment");
      key("\r");
      await vi.waitFor(() =>
        expect(steer).toHaveBeenLastCalledWith("one more adjustment", "run-a"),
      );
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      view.dispose();
    }
  });
  it("does not let a late submission error overwrite a newer draft", async () => {
    const { view } = fixture();
    let reject!: (error: Error) => void;
    view.options.onPrompt = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    view.editor.setText("old task");
    view.editor.handleInput("\r");
    await vi.waitFor(() => expect(reject).toBeDefined());
    view.editor.setText("new draft");
    reject(Error("offline"));
    await vi.waitFor(() =>
      expect(view.inputError.render(80).join("\n")).toContain("offline"),
    );
    expect(view.editor.getExpandedText()).toBe("new draft");
    view.dispose();
  });
});

it("discards stale object details and their actions after changing selection", async () => {
  const { tui, view } = fixture();
  let complete!: (detail: ObjectDetail) => void;
  const stale = vi.fn();
  const page = new ObjectPage(
    {
      title: "Activity",
      description: "",
      load: async () => [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
      detail: async (item) =>
        item.id === "a"
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : { title: "B", text: "Current detail" },
    },
    tui,
  );
  const screen = () =>
    stripVTControlCharacters(
      renderLayoutFrame(page, 80, 18, () => {}).lines.join("\n"),
    );
  try {
    await page.refresh();
    const old = page.inspect();
    page.closeDetails();
    page.handleInput("\x1b[B");
    await page.inspect();
    complete({
      title: "A",
      text: "Stale detail",
      actions: [{ id: "stale", title: "Delete A", run: stale }],
    });
    await old;
    expect(screen()).toContain("Current detail");
    expect(screen()).not.toContain("Stale detail");
    page.handleInput("1");
    expect(stale).not.toHaveBeenCalled();
  } finally {
    page.dispose();
    view.dispose();
  }
});

it("removes only an explicit attachment span and preserves code, whitespace and quoted paths", () => {
  let draft =
    'Keep `@same.txt` and @"file name.ts"  with @same.txt\n```\n@same.txt\n```';
  const strip = new AttachmentStrip(
    () => draft,
    (text) => {
      draft = text;
    },
    () => {},
    () => {},
  );
  strip.remove("same.txt");
  expect(draft).toBe(
    'Keep `@same.txt` and @"file name.ts"  with \n```\n@same.txt\n```',
  );
  strip.remove("file name.ts");
  expect(draft).toBe("Keep `@same.txt` and   with \n```\n@same.txt\n```");
});

it("returns from a model picker after switching away without restoring a closed panel", () => {
  const { view, tui } = fixture();
  const picker = view.openModelPanel();
  view.setActive(false);
  picker.close();
  view.setActive(true);
  expect(tui.getFocusedComponent()).toBe(view.editor);
  view.dispose();
});

it("passes the actual work area height through to object readers", async () => {
  const { view } = fixture();
  view.setWorkspaceSources({
    Changes: {
      title: "Changes",
      description: "",
      load: async () => [{ id: "a", title: "src/auth.ts" }],
      detail: async () => ({
        title: "src/auth.ts",
        text: "first line\nsecond line\nthird line",
        actions: [{ id: "read", title: "Mark read", run() {} }],
      }),
    },
  });
  await view.openWorkspaceObject("Changes", "a");
  const text = stripVTControlCharacters(
    renderLayoutFrame(view.layout, 80, 24, () => {}).lines.join("\n"),
  );
  expect(text).toContain("third line");
  expect(text).toContain("Mark read");
  view.dispose();
});

it("searching an inspected page cannot execute the previous object's action", async () => {
  const { tui, view } = fixture();
  const a = vi.fn(),
    b = vi.fn();
  const page = new ObjectPage(
    {
      title: "Changes",
      description: "",
      load: async () => [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
      detail: async (item) => ({
        title: item.title,
        text: item.id,
        actions: [{ id: "act", title: "Act", run: item.id === "a" ? a : b }],
      }),
    },
    tui,
  );
  try {
    await page.refresh();
    await page.inspect();
    page.handleInput("/");
    page.handleInput("Beta");
    page.handleInput("\r");
    expect(page.inspecting).toBe(false);
    page.handleInput("\r");
    await Promise.resolve();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    page.handleInput("1");
    await Promise.resolve();
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  } finally {
    page.dispose();
    view.dispose();
  }
});

it("distinguishes submission, durable application and an unapplied intervention at run end", async () => {
  const { view, event } = fixture();
  let id = "first";
  view.options.onSteer = async () => id;
  try {
    event("run.start", { runId: "run" });
    view.editor.onSubmit?.("adjust");
    await vi.waitFor(() =>
      expect(view.footer.render(120).join("\n")).toContain(
        "intervention pending",
      ),
    );
    event("message", {
      steeringId: "first",
      message: { role: "user", text: "adjust", timestamp: 1 },
    });
    expect(view.footer.render(120).join("\n")).toContain(
      "intervention applied",
    );
    id = "second";
    view.editor.onSubmit?.("another adjustment");
    await vi.waitFor(() =>
      expect(view.footer.render(120).join("\n")).toContain(
        "intervention pending",
      ),
    );
    event("run.end", { runId: "run", status: "completed" });
    expect(view.footer.render(120).join("\n")).toContain(
      "intervention unapplied",
    );
  } finally {
    view.dispose();
  }
});

it("keeps text attachment interventions as drafts before reading or submitting any file", async () => {
  const { view, event, steer, prompt } = fixture();
  const prepare = vi.fn(async () => ({ text: "expanded file contents" }));
  view.options.preparePrompt = prepare;
  try {
    event("run.start", { runId: "run" });
    view.editor.setText("review @auth.ts");
    view.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(view.inputError.render(120).join("\n")).toContain(
        "Attachments require Queue",
      ),
    );
    expect(view.editor.getExpandedText()).toBe("review @auth.ts");
    expect(prepare).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    view.dispose();
  }
});

it("coalesces live refreshes without aborting an object's pending operation or submitting it twice", async () => {
  const { tui, view } = fixture();
  let release!: () => void;
  let detailSignal!: AbortSignal;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const load = vi.fn(async () => [{ id: "queue-a", title: "Queued task" }]);
  const page = new ObjectPage(
    {
      title: "Activity",
      description: "",
      load,
      detail: async (_item, signal) => {
        detailSignal = signal;
        return {
          title: "A",
          text: "pending",
          actions: [{ id: "edit", title: "Edit", run }],
        };
      },
    },
    tui,
  );
  try {
    await page.refresh();
    await page.inspect();
    const oldSignal = detailSignal;
    page.handleInput("1");
    page.handleInput("1");
    await page.refresh();
    await page.refresh();
    expect(run).toHaveBeenCalledOnce();
    expect(oldSignal.aborted).toBe(false);
    expect(load).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
  } finally {
    page.dispose();
    view.dispose();
  }
});

it("retains the streaming prefix while reading older history and returning to latest", async () => {
  const { view, event } = fixture();
  view.options.onHistory = async (direction) => ({
    messages: [],
    hasOlder: direction === "latest",
    hasNewer: direction === "older",
  });
  try {
    event("run.start", { runId: "run" });
    event("text.delta", { text: "Hello " });
    await view.actions.run("older");
    event("text.delta", { text: "world" });
    view.editor.onSubmit?.("/latest");
    await vi.waitFor(() => {
      const text = stripVTControlCharacters(
        renderLayoutFrame(view.layout, 80, 24, () => {}).lines.join("\n"),
      );
      expect(text).toContain("Hello world");
    });
  } finally {
    view.dispose();
  }
});

it("does not downgrade a run-specific stop into a broad cancel when identity is unknown", async () => {
  const { view, event } = fixture();
  const cancel = vi.fn();
  view.bind({
    prompt: async () => {},
    steer() {},
    cancel,
    subscribe: () => () => {},
  });
  view.options.onCancelRun = vi.fn(async () => {});
  try {
    event("run.start");
    await expect(view.actions.run("stop")).rejects.toThrow(
      "Run identity is unknown",
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(view.options.onCancelRun).not.toHaveBeenCalled();
  } finally {
    view.dispose();
  }
});
