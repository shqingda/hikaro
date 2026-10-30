import { expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSharedHost } from "../packages/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it("changes defaults without changing the active session and exposes host configuration", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-navigation-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const host = await serveSharedHost({ home, cwd, demo: true });
  const client = await SharedHostClient.connect({ home, cwd });
  try {
    await client.request("hello");
    const session = await client.request("session.create");
    const cap = await client.request("model.capabilities", {
      provider: "demo",
      model: "offline",
    });
    expect(cap.contextWindow).toBe(32000);
    await client.request("model.default", {
      sessionId: session.id,
      provider: "demo",
      model: "offline",
      settings: { contextWindow: 16000 },
    });
    expect(
      await client.request("model.read", { sessionId: session.id }),
    ).toMatchObject({
      current: { settings: {} },
      default: { settings: { contextWindow: 16000 } },
    });
    await expect(
      client.request("model.default", {
        sessionId: session.id,
        provider: "demo",
        model: "offline",
        settings: { contextWindow: 64000 },
      }),
    ).rejects.toThrow(/capabilities/);
    const next = await client.request("session.create");
    expect(next.modelSelection.settings.contextWindow).toBe(16000);
    await client.request("permissions.set", { mode: "auto" });
    expect(await client.request("workspace.current")).toMatchObject({
      permissionMode: "auto",
    });
    const resources = await client.request("resources.list", {
      query: "read_file",
    });
    expect(
      resources.items.some((r: { name: string }) => r.name === "read_file"),
    ).toBe(true);
    await client.request("providers.reload");
    expect(await client.request("resources.reload")).toMatchObject({
      instructions: expect.any(Number),
      skills: expect.any(Number),
    });
    await expect(
      client.request("resources.install", {
        kind: "plugin",
        path: "/untrusted",
        trusted: false,
      }),
    ).rejects.toThrow(/trusted/);
  } finally {
    await client.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("signs in through the real secret-input panel without sending credentials to RPC, and cancels replacement", async () => {
  const { vi } = await import("vitest");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const { ProviderCatalog } =
    await import("../packages/provider-pi/src/catalog.ts");
  const { ModelPanel } = await import("../packages/tui/src/model-panel.ts");
  const { AttachedNavigation } =
    await import("../packages/cli/src/attached-navigation.ts");
  const { ClientConnection } =
    await import("../packages/client-core/src/connection.ts");
  const { ClientFiles } = await import("../packages/host/src/client-files.ts");
  const { defaultTuiPreferences } =
    await import("../packages/tui/src/preferences.ts");
  const { randomUUID } = await import("node:crypto");
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-auth-navigation-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const host = await serveSharedHost({ home, cwd, demo: true });
  const transport = await SharedHostClient.connect({ home, cwd });
  const sent: unknown[] = [];
  const send = transport.send.bind(transport);
  vi.spyOn(transport, "send").mockImplementation((frame) => {
    sent.push(frame);
    return send(frame);
  });
  const client = new ClientConnection(transport.scope, transport, {
    id: randomUUID,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  const credentials = new InMemoryCredentialStore();
  const catalog = new ProviderCatalog(home, credentials);
  // Authentication uses the SDK's API-key flow; suppress only network catalog refresh.
  vi.spyOn(catalog, "refresh").mockResolvedValue(undefined);
  let abort = new AbortController();
  let panel: InstanceType<typeof ModelPanel>;
  const view = {
    openModelPanel: () => {
      abort = new AbortController();
      panel = new ModelPanel(abort.signal, () => {});
      return { panel, signal: abort.signal, close: () => abort.abort() };
    },
    notice: vi.fn(),
    setError: vi.fn(),
  } as unknown as import("../packages/tui/src/index.ts").HikaroView;
  try {
    await client.connected();
    await client.request("session.create");
    const files = await ClientFiles.open(
      home,
      transport.endpoint.key,
      transport.scope,
    );
    const menu = new AttachedNavigation(
      client,
      view,
      files,
      defaultTuiPreferences,
      async () => catalog,
      async () => {},
      async () => {},
    );
    const wait = (text: string) =>
      vi.waitFor(() => expect(panel.render(100).join("\n")).toContain(text));
    const login = menu.command("/login");
    await wait("Select provider to configure");
    panel!.handleInput("opencode-go");
    panel!.handleInput("\r");
    await wait("Select authentication method");
    panel!.handleInput("\r");
    await wait("Enter OpenCode API key");
    panel!.handleInput("fixture-private-key");
    expect(panel!.render(100).join("\n")).not.toContain("fixture-private-key");
    panel!.handleInput("\r");
    await wait("Select model");
    abort.abort();
    await login;
    expect(await credentials.read("opencode-go")).toMatchObject({
      type: "api_key",
      key: "fixture-private-key",
    });
    expect(JSON.stringify(sent)).not.toContain("fixture-private-key");
    const reloads = () =>
      sent.filter(
        (f) => (f as { method: string }).method === "providers.reload",
      ).length;
    expect(reloads()).toBeGreaterThan(0);
    const before = reloads();
    const declined = menu.command("/login", "opencode-go");
    await wait("Replace sign-in");
    expect(panel!.render(100).join("\n")).toContain("shared Hikaro host home");
    panel!.handleInput("\r");
    await wait("Select provider to configure");
    abort.abort();
    await declined;
    expect(await credentials.read("opencode-go")).toMatchObject({
      key: "fixture-private-key",
    });
    expect(reloads()).toBe(before);

    const cancelled = menu.command("/login", "opencode-go");
    await wait("Replace sign-in");
    panel!.handleInput("\x1b[B");
    panel!.handleInput("\r");
    await wait("Select authentication method");
    panel!.handleInput("\r");
    await wait("Enter OpenCode API key");
    panel!.handleInput("replacement-not-saved");
    abort.abort();
    await cancelled;
    expect(await credentials.read("opencode-go")).toMatchObject({
      key: "fixture-private-key",
    });
    expect(reloads()).toBe(before);
    expect(view.setError).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    client.close();
    await transport.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("isolates attached view preferences and rejects delayed configuration reads after disconnect", async () => {
  const { vi } = await import("vitest");
  const { ClientFiles } = await import("../packages/host/src/client-files.ts");
  const { AttachedNavigation } =
    await import("../packages/cli/src/attached-navigation.ts");
  const { defaultTuiPreferences } =
    await import("../packages/tui/src/preferences.ts");
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-view-preferences-")),
  );
  try {
    const first = await ClientFiles.open(home, "workspace", "first"),
      second = await ClientFiles.open(home, "workspace", "second");
    await first.savePreferences({ ...defaultTuiPreferences, showUsage: false });
    expect(await second.preferences()).toBeNull();
    expect(
      await (await ClientFiles.open(home, "workspace", "first")).preferences(),
    ).toMatchObject({ showUsage: false });
    let resolve!: (v: unknown) => void;
    const response = new Promise<unknown>((done) => {
      resolve = done;
    });
    const client = {
      state: { canAct: true, busy: false, session: { id: "selected" } },
      request: vi.fn(() => response),
    } as unknown as import("../packages/client-core/src/connection.ts").ClientConnection;
    const view = {
      openModelPanel: vi.fn(),
    } as unknown as import("../packages/tui/src/index.ts").HikaroView;
    const menu = new AttachedNavigation(
      client,
      view,
      first,
      defaultTuiPreferences,
      async () => {
        throw Error("No authentication expected");
      },
      async () => {},
      async () => {},
    );
    const command = menu.command("/context");
    const rejected = expect(command).rejects.toThrow(/Connection changed/);
    menu.disconnected();
    resolve({ current: { provider: "demo", model: "offline", settings: {} } });
    await rejected;
    expect(view.openModelPanel).not.toHaveBeenCalled();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
