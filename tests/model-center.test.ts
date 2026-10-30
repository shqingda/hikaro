import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import {
  openModelPicker,
  type ModelPickerCatalog,
} from "../packages/tui/src/model-picker.ts";

function center(
  catalog: ModelPickerCatalog,
  options: Parameters<typeof openModelPicker>[3] = {},
) {
  const abort = new AbortController();
  const panel = new ModelPanel(
    abort.signal,
    () => {},
    () => 30,
  );
  const select = vi.fn(async () => {});
  const error = vi.fn();
  const run = openModelPicker(
    {
      openModelPanel: () => ({
        panel,
        signal: abort.signal,
        close: () => abort.abort(),
      }),
      setError: error,
      notice: vi.fn(),
    },
    catalog,
    select,
    options,
  );
  return {
    abort,
    panel,
    select,
    error,
    run,
    output: () => panel.render(100).join("\n"),
  };
}
function fakeCatalog(): ModelPickerCatalog {
  return {
    available: async () => [{ provider: "test", id: "alpha", name: "Alpha" }],
    providers: async () => [
      {
        id: "test",
        name: "Test Provider",
        configured: false,
        stored: false,
        source: "none",
        methods: [{ id: "api_key", label: "API key" }],
      },
    ],
    login: vi.fn(async () => {}),
    refresh: vi.fn(async () => undefined),
  };
}

it("does not call select while a running session blocks model switching but keeps browsing available", async () => {
  const ui = center(fakeCatalog(), {
    switchBlockedReason: () => "Stop the running task before switching",
  });
  await vi.waitFor(() => expect(ui.output()).toContain("Alpha"));
  ui.panel.handleInput("\r");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() =>
    expect(ui.output()).toContain("Stop the running task"),
  );
  expect(ui.select).not.toHaveBeenCalled();
  ui.panel.handleInput("\t");
  await vi.waitFor(() => expect(ui.output()).toContain("Test Provider"));
  ui.abort.abort();
  await ui.run;
});

it("hides and disables saving defaults when the backend does not support it", async () => {
  const ui = center(fakeCatalog(), { saveDefault: false });
  await vi.waitFor(() => expect(ui.output()).toContain("Alpha"));
  expect(ui.output()).not.toContain("Ctrl+S");
  ui.panel.handleInput("\x13");
  expect(ui.select).not.toHaveBeenCalled();
  ui.panel.handleInput("\r");
  await ui.run;
  expect(ui.select).toHaveBeenCalledWith("test", "alpha", false);
});

it("ignores late authentication callbacks after cancellation and never refreshes a cancelled attempt", async () => {
  const catalog = fakeCatalog();
  let notify:
    ((event: { type: "progress"; message: string }) => void) | undefined;
  let complete: (() => void) | undefined;
  catalog.login = vi.fn(async (_provider, _method, interaction) => {
    notify = interaction.notify;
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const ui = center(catalog, { mode: "login", provider: "test" });
  await vi.waitFor(() => expect(ui.output()).toContain("API key"));
  ui.panel.handleInput("\r");
  await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
  ui.abort.abort();
  await ui.run;
  notify!({ type: "progress", message: "Late callback must not repaint" });
  complete!();
  await Promise.resolve();
  expect(ui.output()).not.toContain("Late callback");
  expect(catalog.refresh).not.toHaveBeenCalled();
  expect(ui.error).not.toHaveBeenCalled();
});

it("logout starts with cancel selected and explains shared-session impact before removing credentials", async () => {
  const catalog = fakeCatalog();
  catalog.providers = async () => [
    {
      id: "test",
      name: "Test Provider",
      configured: true,
      stored: true,
      source: "stored",
      methods: [],
    },
  ];
  catalog.logout = vi.fn(async () => {});
  const ui = center(catalog, {
    mode: "logout",
    provider: "test",
    ownerLabel: "Host credential store",
    affectedSessions: async () => ["Session alpha"],
  });
  await vi.waitFor(() => expect(ui.output()).toContain("Session alpha"));
  expect(ui.output()).toContain("Host credential store");
  ui.panel.handleInput("\r");
  await vi.waitFor(() => expect(ui.output()).toContain("Providers"));
  expect(catalog.logout).not.toHaveBeenCalled();
  ui.abort.abort();
  await ui.run;
});

it("retains an authenticated provider's cached models when refresh fails and hides secret input", async () => {
  const catalog = fakeCatalog();
  catalog.login = vi.fn(async (_provider, _method, interaction) => {
    expect(
      await interaction.prompt({ type: "secret", message: "Enter API key" }),
    ).toBe("private-value");
  });
  catalog.refresh = vi.fn(async () => "Network unavailable");
  const changed = vi.fn();
  const ui = center(catalog, {
    mode: "login",
    provider: "test",
    onCredentialsChanged: changed,
  });
  await vi.waitFor(() => expect(ui.output()).toContain("API key"));
  ui.panel.handleInput("\r");
  await vi.waitFor(() => expect(ui.output()).toContain("Enter API key"));
  ui.panel.handleInput("private-value");
  expect(ui.output()).not.toContain("private-value");
  ui.panel.handleInput("\r");
  ui.panel.handleInput("\r");
  await vi.waitFor(() => expect(ui.output()).toContain("Network unavailable"));
  expect(ui.output()).toContain("Alpha");
  expect(changed).toHaveBeenCalledWith("test", "login");
  expect(catalog.login).toHaveBeenCalledTimes(1);
  expect(ui.select).not.toHaveBeenCalled();
  ui.abort.abort();
  await ui.run;
});

it("explains a failed credential removal inside the center and retains the stored account", async () => {
  const catalog = fakeCatalog();
  catalog.providers = async () => [
    {
      id: "test",
      name: "Test Provider",
      configured: true,
      stored: true,
      methods: [],
    },
  ];
  catalog.logout = vi.fn(async () => {
    throw Error("Keychain locked");
  });
  const ui = center(catalog, { mode: "logout", provider: "test" });
  await vi.waitFor(() => expect(ui.output()).toContain("Other sessions"));
  ui.panel.handleInput("\x1b[B");
  ui.panel.handleInput("\r");
  await vi.waitFor(() => expect(ui.output()).toContain("Keychain locked"));
  expect(ui.output()).toContain("Test Provider");
  expect(ui.error).not.toHaveBeenCalled();
  ui.abort.abort();
  await ui.run;
});

it("reports stored and ambient credential sources without reading secrets, and logout preserves ambient access", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-center-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "stored-secret",
  }));
  const read = vi.spyOn(credentials, "read");
  vi.stubEnv("OPENAI_API_KEY", "ambient-secret");
  try {
    const catalog = new ProviderCatalog(home, credentials);
    expect(
      (await catalog.providers()).find((p) => p.id === "openai"),
    ).toMatchObject({
      source: "stored",
      credentialType: "api_key",
      ambientSource: "OPENAI_API_KEY",
    });
    expect(read).not.toHaveBeenCalled();
    await catalog.logout("openai", new AbortController().signal);
    expect(
      (await catalog.providers()).find((p) => p.id === "openai"),
    ).toMatchObject({
      stored: false,
      configured: true,
      source: "environment",
      ambientSource: "OPENAI_API_KEY",
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("persists favorites and bounded recents separately from credentials across catalog instances", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-center-"));
  try {
    const first = new ProviderCatalog(home, new InMemoryCredentialStore());
    const second = new ProviderCatalog(home, new InMemoryCredentialStore());
    await Promise.all([
      first.setFavorite({ provider: "one", model: "a" }, true),
      second.setFavorite({ provider: "two", model: "a" }, true),
    ]);
    for (let i = 0; i < 12; i++)
      await first.recordRecent({ provider: "one", model: String(i) });
    await first.recordRecent({ provider: "one", model: "10" });
    const prefs = await second.readPreferences();
    expect(prefs.favorites).toHaveLength(2);
    expect(prefs.recent).toHaveLength(10);
    expect(prefs.recent[0]).toEqual({ provider: "one", model: "10" });
    await second.setFavorite({ provider: "one", model: "a" }, false);
    expect((await first.readPreferences()).favorites).toEqual([
      { provider: "two", model: "a" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("model panel preserves a search and selection when invoking a contextual action", async () => {
  const panel = new ModelPanel(new AbortController().signal, () => {});
  const selected = panel.choose(
    "Models",
    [{ value: "one/a", label: "Alpha", description: "one" }],
    "",
    undefined,
    {
      search: true,
      searchQuery: "Alpha",
      actions: [{ id: "favorite", key: "ctrl+f", label: "favorite" }],
    },
  );
  panel.handleInput("\x06");
  expect(await selected).toMatchObject({
    value: "one/a",
    action: "favorite",
    query: "Alpha",
  });
});

it("model panel switches pages with Tab without consuming a draft or exposing secrets on cancel", async () => {
  const panel = new ModelPanel(new AbortController().signal, () => {});
  const selected = panel.choose("Models", [], "", undefined, {
    search: true,
    tabs: [
      { value: "models", label: "Models" },
      { value: "providers", label: "Providers" },
    ],
    activeTab: "models",
  });
  panel.handleInput("\t");
  expect(await selected).toMatchObject({ value: "providers", action: "tab" });
  const answer = panel
    .prompt("API key", true)
    .catch((error: Error) => error.name);
  panel.handleInput("secret-value");
  expect(panel.render(60).join("\n")).not.toContain("secret-value");
  panel.cancelPrompt();
  expect(await answer).toBe("AbortError");
  expect(panel.render(60).join("\n")).not.toContain("secret-value");
});
