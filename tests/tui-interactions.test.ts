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
import type { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import type { ModelSelection } from "../packages/core/src/types.ts";

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
      rows: 24,
      columns: 80,
      write: () => {},
    } as Terminal);
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
