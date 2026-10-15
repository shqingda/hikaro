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
    cwd: "/tmp",
    model: "fixture",
    onPrompt,
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
      fixture.panel.handleInput("Next page");
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
