import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { openGeneralSettings } from "../packages/tui/src/general-settings.ts";
import {
  defaultTuiPreferences,
  type TuiPreferences,
} from "../packages/tui/src/preferences.ts";
import { HikaroView } from "../packages/tui/src/index.ts";
import { openModelPicker } from "../packages/tui/src/model-picker.ts";
import { openModelControl } from "../packages/tui/src/model-settings.ts";
import { openSessions } from "../packages/tui/src/sessions.ts";
import type { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import type {
  AgentEvent,
  ModelSelection,
  Session,
} from "../packages/core/src/types.ts";

const terminalStub: Terminal = {
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
};

function shortcutFixture() {
  const abort = new AbortController();
  const watchers = new Set<() => void>();
  const panel = new ModelPanel(abort.signal, () => {
    for (const watch of watchers) watch();
  });
  const screen = () => stripVTControlCharacters(panel.render(100).join("\n"));
  const waitFor = (pattern: RegExp) =>
    new Promise<void>((done, reject) => {
      const check = () => {
        if (!pattern.test(screen())) return;
        clearTimeout(timer);
        watchers.delete(check);
        done();
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(Error(`Picker did not update: ${pattern}\n${screen()}`));
      }, 1000);
      watchers.add(check);
      check();
    });
  const setError = vi.fn();
  const view = {
    openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
    notice: vi.fn(),
    setError,
  } as unknown as HikaroView;
  return { abort, panel, screen, waitFor, view, setError };
}

function interactionView(
  onPrompt: (text: string) => Promise<void> = async () => {},
  onDraftChange?: (text: string) => void,
  preparePrompt?: (
    text: string,
    signal: AbortSignal,
  ) => Promise<{ text: string }>,
  cwd = "/tmp",
) {
  const tui = new TuiAltScreen({ ...terminalStub });
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let input!: (data: string) => unknown;
  vi.spyOn(tui, "addInputListener").mockImplementation((listener) => {
    input = listener;
    return () => {};
  });
  const focus = vi.spyOn(tui, "setFocus");
  const view = new HikaroView(tui, {
    cwd,
    model: "fixture",
    onPrompt,
    onDraftChange,
    preparePrompt,
    onCommand: async () => {},
    onExit: () => {},
  });
  const event = (type: string, data: Record<string, unknown> = {}) =>
    view.event({
      type,
      data,
      sessionId: "fixture",
      seq: 1,
      timestamp: 1,
    } satisfies AgentEvent);
  return { view, input: (data: string) => input(data), focus, event };
}

it("keeps attachment input and draft on preparation failure without dispatching", async () => {
  const prompt = vi.fn(async () => {});
  const saved = vi.fn();
  const { view } = interactionView(prompt, saved, async () => {
    throw Error("File does not exist");
  });
  try {
    view.editor.setText("Review @missing.ts");
    view.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(view.inputError.render(100).join("\n")).toContain(
        "File does not exist",
      ),
    );
    expect(view.editor.getExpandedText()).toBe("Review @missing.ts");
    expect(saved).toHaveBeenLastCalledWith("Review @missing.ts");
    expect(prompt).not.toHaveBeenCalled();
    expect(view.editor.disableSubmit).toBe(false);
  } finally {
    view.dispose();
  }
});

it("cancels attachment preparation while retaining the input, even if the loader returns late", async () => {
  const prompt = vi.fn(async () => {});
  let release!: () => void;
  const { view, input } = interactionView(prompt, undefined, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { text: "prepared" };
  });
  try {
    view.editor.setText("Review @large.ts");
    view.editor.handleInput("\r");
    expect(view.editor.getExpandedText()).toBe("Review @large.ts");
    expect(view.editor.disableSubmit).toBe(true);
    expect(input("x")).toEqual({ consume: true });
    input("\x03");
    release();
    await vi.waitFor(() => expect(view.editor.disableSubmit).toBe(false));
    expect(prompt).not.toHaveBeenCalled();
    expect(view.editor.getExpandedText()).toBe("Review @large.ts");
  } finally {
    view.dispose();
  }
});

it("autosaves expanded paste text but excludes transient dialog answers", () => {
  const saved = vi.fn();
  const { view, event } = interactionView(async () => {}, saved);
  try {
    const draft = "line of pasted content\n".repeat(30);
    view.editor.handleInput("\x1b[200~" + draft + "\x1b[201~");
    expect(saved).toHaveBeenLastCalledWith(draft);
    event("ui.request", {
      id: "private",
      method: "input",
      title: "Input",
      prefill: "private-prefill",
    });
    view.editor.handleInput("private-answer");
    expect(saved.mock.calls.every(([text]) => !text.includes("private"))).toBe(
      true,
    );
    event("ui.closed", { id: "private" });
    expect(view.editor.getExpandedText()).toBe(draft);
  } finally {
    view.dispose();
  }
});

describe("TUI immediate cancellation feedback", () => {
  it.each(["\x1b", "\x03"])(
    "restores input immediately when cancelling a loading panel with %j",
    (key) => {
      const fixture = interactionView();
      try {
        fixture.view.editor.setText("草稿🙂");
        const first = fixture.view.openModelPanel();
        first.panel.progress("Loading providers…");
        fixture.input(key);
        expect(first.signal.aborted).toBe(true);
        expect(fixture.focus).toHaveBeenLastCalledWith(fixture.view.editor);
        expect(fixture.view.modelSlot.children).toHaveLength(0);
        expect(fixture.view.editor.getText()).toBe("草稿🙂");
        const next = fixture.view.openModelPanel();
        next.panel.progress("New panel");
        first.close();
        expect(next.signal.aborted).toBe(false);
        expect(fixture.view.modelSlot.children).toHaveLength(1);
        next.close();
      } finally {
        fixture.view.dispose();
      }
    },
  );

  it("refreshes status before a cancelled dialog response completes", async () => {
    const fixture = interactionView();
    let finish!: () => void;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const respondToUI = vi.fn(() => response);
    const backend = {
      prompt: async () => {},
      cancel: () => {},
      steer: () => {},
      subscribe: () => () => {},
      respondToUI,
    };
    fixture.view.bind(backend);
    try {
      fixture.event("run.start");
      fixture.view.editor.setText("Saved draft");
      fixture.event("ui.request", {
        id: "dialog",
        method: "input",
        title: "Extension input",
      });
      expect(fixture.view.editor.render(36)[0]).toContain("Waiting for input");
      fixture.input("\x1b");
      expect(fixture.view.editor.getText()).toBe("Saved draft");
      expect(fixture.view.editor.render(36)[0]).toContain("Working");
      expect(fixture.view.footer.render(36).join("\n")).toContain(
        "Ctrl+C stops",
      );
      expect(respondToUI).toHaveBeenCalledWith("dialog", { cancelled: true });
    } finally {
      finish();
      await response;
      fixture.view.dispose();
    }
  });

  it("keeps cancellation quiet while showing actual prompt errors", async () => {
    for (const error of [
      new DOMException("Cancelled", "AbortError"),
      Error("Provider unavailable"),
    ]) {
      const fixture = interactionView(async () => {
        throw error;
      });
      try {
        fixture.view.editor.onSubmit?.("Task");
        await Promise.resolve();
        const screen = stripVTControlCharacters(
          fixture.view.inputError.render(36).join("\n"),
        ).trim();
        expect(screen).toBe(
          error.name === "AbortError" ? "" : "Error: Provider unavailable",
        );
      } finally {
        fixture.view.dispose();
      }
    }
  });
});

describe("TUI shortcut capabilities", () => {
  it("ignores default shortcuts in provider, authentication and utility choices", async () => {
    const fixture = shortcutFixture();
    const { panel, screen, waitFor, view } = fixture;
    const login = vi.fn(async () => {});
    const select = vi.fn(async () => {});
    const catalog = {
      providers: async () => [
        {
          id: "demo",
          name: "Demo",
          configured: false,
          methods: [{ id: "api_key", label: "API key" }],
        },
      ],
      login,
      refresh: async () => undefined,
      available: async () => [
        { provider: "demo", id: "model", name: "Demo model" },
      ],
    } as unknown as ProviderCatalog;
    const work = openModelPicker(view, catalog, select, true);
    try {
      await waitFor(/Select provider to configure/);
      expect(screen()).not.toContain("Ctrl+S");
      panel.handleInput("\x13");
      await Promise.resolve();
      expect(screen()).toContain("Select provider to configure");
      panel.handleInput("\r");
      await waitFor(/Select authentication method/);
      expect(screen()).not.toContain("Ctrl+S");
      panel.handleInput("\x13");
      await Promise.resolve();
      expect(login).not.toHaveBeenCalled();
      expect(screen()).toContain("Select authentication method");
      panel.handleInput("\r");
      await waitFor(/Select model/);
      expect(login).toHaveBeenCalledOnce();
      expect(screen()).toContain("Ctrl+S active + default");
      panel.handleInput("\x1b[B");
      expect(screen()).not.toContain("Ctrl+S");
      panel.handleInput("\x13");
      await Promise.resolve();
      expect(screen()).toContain("Select model");
      expect(select).not.toHaveBeenCalled();
      panel.handleInput("\x1b[A");
      panel.handleInput("\x13");
      await work;
      expect(select).toHaveBeenCalledExactlyOnceWith("demo", "model", true);
      expect(fixture.setError).not.toHaveBeenCalled();
    } finally {
      fixture.abort.abort();
      await work;
    }
  });

  it("enables active plus default saving only in the active model setting scope", async () => {
    const active: ModelSelection = {
      provider: "demo",
      model: "active",
      settings: { reasoning: "high" },
    };
    const defaults: ModelSelection = {
      provider: "demo",
      model: "default",
      settings: { reasoning: "high" },
    };
    const catalog = {
      capabilities: async () => ({ reasoning: ["low", "high"] }),
    } as unknown as ProviderCatalog;
    for (const scope of ["active", "default"] as const) {
      const fixture = shortcutFixture();
      const apply = vi.fn(async () => {});
      const save = vi.fn(async () => {});
      const work = openModelControl(
        fixture.view,
        catalog,
        "thinking",
        active,
        defaults,
        apply,
        save,
        scope,
      );
      try {
        await fixture.waitFor(new RegExp(`/thinking · ${scope}`));
        if (scope === "active") {
          for (let i = 0; i < 3; i++) fixture.panel.handleInput("\x1b[B");
          expect(fixture.screen()).not.toContain("Ctrl+S");
          expect(fixture.screen()).toContain("Enter switch scope");
          fixture.panel.handleInput("\x13");
          await Promise.resolve();
          expect(apply).not.toHaveBeenCalled();
          expect(save).not.toHaveBeenCalled();
          for (let i = 0; i < 3; i++) fixture.panel.handleInput("\x1b[A");
        }
        fixture.panel.handleInput("\x1b[B");
        if (scope === "active") {
          expect(fixture.screen()).toContain("Ctrl+S active + default");
          fixture.panel.handleInput("\x13");
        } else {
          expect(fixture.screen()).not.toContain("Ctrl+S");
          fixture.panel.handleInput("\x13");
          await Promise.resolve();
          expect(apply).not.toHaveBeenCalled();
          expect(save).not.toHaveBeenCalled();
          fixture.panel.handleInput("\r");
        }
        await work;
        expect(save).toHaveBeenCalledExactlyOnceWith({
          ...(scope === "active" ? active : defaults),
          settings: { reasoning: "low" },
        });
        if (scope === "active")
          expect(apply).toHaveBeenCalledExactlyOnceWith({ reasoning: "low" });
        else expect(apply).not.toHaveBeenCalled();
        expect(fixture.setError).not.toHaveBeenCalled();
      } finally {
        fixture.abort.abort();
        await work;
      }
    }
  });
});

describe("TUI interaction fixes", () => {
  it("finishes a cancelled picker when model loading completes", async () => {
    const fixture = shortcutFixture();
    let finishLoading!: (
      models: Array<{ provider: string; id: string; name: string }>,
    ) => void;
    const loading = new Promise<
      Array<{ provider: string; id: string; name: string }>
    >((resolve) => {
      finishLoading = resolve;
    });
    const close = vi.fn();
    fixture.view.openModelPanel = () => ({
      panel: fixture.panel,
      signal: fixture.abort.signal,
      close,
    });
    const catalog = { available: () => loading } as unknown as ProviderCatalog;
    const select = vi.fn();
    const work = openModelPicker(fixture.view, catalog, select);
    fixture.abort.abort();
    finishLoading([{ provider: "demo", id: "offline", name: "Offline" }]);
    await work;
    expect(close).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(fixture.setError).not.toHaveBeenCalled();
  });

  it("refuses selection and text prompts after cancellation", () => {
    const fixture = shortcutFixture();
    fixture.abort.abort();
    expect(() => fixture.panel.choose("Closed", [])).toThrow();
    expect(() => fixture.panel.prompt("Closed")).toThrow();
  });

  it("ignores destructive shortcuts on session pagination rows", async () => {
    const fixture = shortcutFixture();
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: String(i),
      title: `Session ${i}`,
      cwd: "/tmp",
      createdAt: i,
    })) satisfies Session[];
    const list = vi.fn(async (offset: number) => (offset ? [rows[50]!] : rows));
    const remove = vi.fn(async () => undefined);
    const rename = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    const work = openSessions(
      fixture.view,
      () => "0",
      list,
      resume,
      remove,
      rename,
    );
    try {
      await fixture.waitFor(/Sessions · page 1/);
      for (let index = 0; index < 50; index++)
        fixture.panel.handleInput("\x1b[B");
      expect(fixture.screen()).toContain("Enter next page");
      expect(fixture.screen()).not.toMatch(/delete|rename/);
      fixture.panel.handleInput("\x04");
      fixture.panel.handleInput("\x12");
      await Promise.resolve();
      expect(list).toHaveBeenCalledTimes(1);
      fixture.panel.handleInput("\r");
      await fixture.waitFor(/Sessions · page 2/);
      expect(fixture.screen()).toContain("Enter resume");
      expect(fixture.screen()).toMatch(/delete/);
      expect(fixture.screen()).toMatch(/rename/);
      fixture.panel.handleInput("\r");
      await work;
      expect(resume).toHaveBeenCalledWith("50");
      expect(remove).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    } finally {
      fixture.abort.abort();
      await work;
    }
  });

  it("finds visible names and descriptions without changing the returned ID", async () => {
    for (const query of ["数据库", "INVESTIGATION", "opaque-b"]) {
      const panel = new ModelPanel(new AbortController().signal, () => {});
      const choice = panel.choose(
        "Sessions",
        [
          { value: "opaque-a", label: "Other task", description: "Finished" },
          {
            value: "opaque-b",
            label: "数据库调查",
            description: "Investigation",
          },
        ],
        "",
        undefined,
        { search: true, emptyMessage: "No matching sessions" },
      );
      panel.handleInput(query);
      expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain(
        "→ 数据库调查",
      );
      panel.handleInput("\r");
      expect((await choice).value).toBe("opaque-b");
    }
    const abort = new AbortController();
    const panel = new ModelPanel(abort.signal, () => {});
    const choice = panel.choose(
      "Sessions",
      [{ value: "id", label: "Task" }],
      "",
      undefined,
      { search: true, emptyMessage: "No matching sessions" },
    );
    const cancelled = choice.catch(() => {});
    panel.handleInput("missing");
    expect(panel.render(100).join("\n")).toContain("No matching sessions");
    panel.handleInput("\x15");
    panel.handleInput("\r");
    expect((await choice).value).toBe("id");
    abort.abort();
    await cancelled;
  });

  it("keeps the setting selected for consecutive toggles in a menu without search", async () => {
    const abort = new AbortController();
    const watchers = new Set<() => void>();
    const panel = new ModelPanel(abort.signal, () => {
      for (const watch of watchers) watch();
    });
    const waitFor = (pattern: RegExp) =>
      new Promise<void>((done, reject) => {
        const check = () => {
          if (
            !pattern.test(
              stripVTControlCharacters(panel.render(100).join("\n")),
            )
          )
            return;
          clearTimeout(timer);
          watchers.delete(check);
          done();
        };
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(Error(`Settings did not update: ${pattern}`));
        }, 1000);
        watchers.add(check);
        check();
      });
    const saved: TuiPreferences[] = [];
    const view = {
      openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
      setError: (text: string) => {
        throw Error(text);
      },
    } as unknown as HikaroView;
    const work = openGeneralSettings(
      view,
      defaultTuiPreferences,
      async (next) => {
        saved.push(next);
      },
    );
    try {
      expect(panel.render(100).join("\n")).not.toContain("Search…");
      for (let i = 0; i < 3; i++) panel.handleInput("\x1b[B");
      panel.handleInput("\r");
      await waitFor(/→ Completion bell[^\n]*On/);
      panel.handleInput("\r");
      await waitFor(/→ Completion bell[^\n]*Off/);
      expect(saved.map((next) => next.completionBell)).toEqual([true, false]);
      expect(saved.every((next) => !next.showToolDetails)).toBe(true);
    } finally {
      abort.abort();
      await work;
    }
  });

  it("keeps the current permission mode visible when usage is hidden", () => {
    const tui = new TuiAltScreen({
      ...terminalStub,
      rows: 24,
      columns: 80,
    });
    vi.spyOn(tui, "requestRender").mockImplementation(() => {});
    const view = new HikaroView(tui, {
      cwd: "/tmp",
      model: "test",
      onPrompt: async () => {},
      onCommand: async () => {},
      onExit: () => {},
    });
    try {
      view.setInfo("usage-only-value");
      view.setPermissionLabel("Full Access");
      view.setPreferences({ ...defaultTuiPreferences, showUsage: false });
      const screen = stripVTControlCharacters(
        view.layout.render(80).join("\n"),
      );
      expect(screen).toContain("Permissions · Full Access");
      expect(screen).not.toContain("usage-only-value");
      view.setPermissionLabel("Ask for approval");
      const updated = stripVTControlCharacters(
        view.layout.render(80).join("\n"),
      );
      expect(updated).toContain("Permissions · Ask for approval");
      expect(updated).not.toContain("Full Access");
    } finally {
      view.dispose();
    }
  });
});

it("searches @ files fuzzily and accepts keyboard selection without submitting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hikaro-complete-"));
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "ignored.txt"), "hidden");
  await writeFile(join(cwd, "alpha.txt"), "a");
  await writeFile(join(cwd, "beta.txt"), "b");
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "docs", "read me.md"), "hello");
  const prompt = vi.fn(async () => {});
  const { view } = interactionView(prompt, undefined, undefined, cwd);
  const screen = () =>
    stripVTControlCharacters(view.editor.render(100).join("\n"));
  try {
    view.editor.handleInput("@");
    await vi.waitFor(() => expect(screen()).toContain("alpha.txt"));
    expect(screen()).not.toContain("ignored.txt");
    view.editor.handleInput("\x1b[B");
    view.editor.handleInput("\t");
    expect(view.editor.getText()).not.toBe("@");
    expect(prompt).not.toHaveBeenCalled();
    view.editor.setText("");
    view.editor.handleInput("@docs/rdme");
    await vi.waitFor(() => expect(screen()).toContain("read me.md"));
    view.editor.handleInput("\r");
    expect(view.editor.getText()).toBe('@"docs/read me.md" ');
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    view.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("yields execution management to a real approval without denying it or losing the draft", async () => {
  const { view, input } = interactionView();
  try {
    view.editor.setText("saved draft");
    const manager = view.openModelPanel({ yieldToApproval: true });
    const waiting = manager.panel
      .choose("Execution manager", [{ value: "close", label: "Close" }])
      .catch((error) => error.name);
    let decided = false;
    const approval = view
      .approve(
        {
          id: "approval",
          sessionId: "fixture",
          tool: "shell",
          reason: "Run a command",
          arguments: { command: "true" },
        },
        new AbortController().signal,
      )
      .then((value) => {
        decided = true;
        return value;
      });
    expect(manager.signal.aborted).toBe(true);
    expect(await waiting).toBe("AbortError");
    expect(decided).toBe(false);
    expect(view.editor.getText()).toBe("saved draft");
    input("\x1b");
    expect(await approval).toBe(false);
  } finally {
    view.dispose();
  }
});

it("lets structured questions replace execution management and preserves the editor draft", async () => {
  const { view } = interactionView();
  try {
    view.editor.setText("draft question");
    const manager = view.openModelPanel({ yieldToApproval: true });
    const questions = view.openModelPanel({ interruptYielding: true });
    expect(manager.signal.aborted).toBe(true);
    expect(questions.signal.aborted).toBe(false);
    questions.close();
    expect(view.editor.getText()).toBe("draft question");
  } finally {
    view.dispose();
  }
});

it("does not redraw an unchanged shared-host status during idle polling", () => {
  const tui = new TuiAltScreen(terminalStub);
  const render = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const view = new HikaroView(tui, {
    cwd: "/tmp",
    model: "shared host",
    onPrompt: async () => {},
    onCommand: async () => {},
    onExit: () => {},
  });
  try {
    view.setInfo("Shared host · session");
    render.mockClear();
    for (let poll = 0; poll < 100; poll++)
      view.setInfo("Shared host · session");
    expect(render).not.toHaveBeenCalled();
    view.setInfo("Host disconnected / synchronizing · draft stays local");
    expect(render).toHaveBeenCalledOnce();
    expect(
      stripVTControlCharacters(view.layout.render(100).join("\n")),
    ).toContain("Host disconnected");
  } finally {
    view.dispose();
  }
});
