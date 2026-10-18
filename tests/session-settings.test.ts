import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import { selectInitialSession } from "../apps/cli/src/startup.ts";
import { openModelControl } from "../packages/tui/src/model-settings.ts";
import {
  loadTuiPreferences,
  saveTuiPreferences,
  defaultTuiPreferences,
} from "../packages/tui/src/preferences.ts";
import { openSessions } from "../packages/tui/src/sessions.ts";
import { openGeneralSettings } from "../packages/tui/src/general-settings.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import type { ModelSelection } from "../packages/core/src/types.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
import type { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";

// Exercise the real provider adapter. Replace only catalog and network I/O.
const capture = vi.hoisted(() => ({
  requests: [] as any[],
  bodies: [] as any[],
  native: false,
}));
vi.mock("../packages/provider-pi/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../packages/provider-pi/src/index.ts")
    >();
  const modelFor = (provider: string, id: string) => ({
    id,
    name: id,
    provider,
    api: "openai-responses" as const,
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    input: ["text" as const],
    thinkingLevelMap: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      max: null,
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const dispatch = async function* (
    native: boolean,
    model: any,
    context: any,
    options: any,
  ) {
    capture.requests.push({ native, model, context, options });
    if (capture.native) {
      const api = await import("@earendil-works/pi-ai/api/openai-responses");
      const fetch = async (_url: unknown, init: RequestInit) => {
        capture.bodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({
            error: {
              message: "Offline request captured",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      };
      const wireOptions = { ...options, apiKey: "sk-offline-test", fetch };
      yield* native
        ? api.stream(model, context, wireOptions)
        : api.streamSimple(model, context, wireOptions);
      return;
    }
    yield { type: "thinking_delta", delta: "A short reasoning summary." };
    yield {
      type: "done",
      message: {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "A short reasoning summary." },
          { type: "text", text: "Saved goal and decisions." },
        ],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    };
  };
  return {
    ...actual,
    createPiProvider: async (
      options: Parameters<typeof actual.createPiProvider>[0],
    ) =>
      actual.createPiProvider({
        ...options,
        collection: {
          getModel: modelFor,
          streamSimple: (model: any, context: any, args: any) =>
            dispatch(false, model, context, args),
          stream: (model: any, context: any, args: any) =>
            dispatch(true, model, context, args),
        } as any,
      }),
  };
});
const runtimes: Runtime[] = [];
const folders: string[] = [];
afterEach(async () => {
  capture.native = false;
  capture.requests.length = 0;
  capture.bodies.length = 0;
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-session-settings-"));
  folders.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const runtime = await Runtime.open({
    home,
    cwd,
    provider: "openai",
    model: "gpt-6.1-sol",
    approve: async () => false,
  });
  runtimes.push(runtime);
  return { runtime, home, cwd };
}

it("interactive startup resumes by default and honors an explicit new session", async () => {
  const { runtime } = await fixture();
  const previous = await runtime.session();
  await runtime.store.rememberSession(previous.id);
  const resumed = await selectInitialSession(
    runtime,
    {},
    defaultTuiPreferences,
  );
  expect(resumed.id).toBe(previous.id);
  const fresh = await selectInitialSession(
    runtime,
    { new: true },
    defaultTuiPreferences,
  );
  expect(fresh.id).not.toBe(previous.id);
});

it("interactive startup never restores a live model implicitly in demo mode", async () => {
  const { runtime, home, cwd } = await fixture();
  const live = await runtime.session();
  await runtime.store.rememberSession(live.id);
  const demo = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  runtimes.push(demo);
  const offline = await selectInitialSession(
    demo,
    { demo: true },
    defaultTuiPreferences,
  );
  expect(offline.modelSelection?.provider).toBe("demo");
  await expect(
    selectInitialSession(
      demo,
      { demo: true, session: live.id },
      defaultTuiPreferences,
    ),
  ).rejects.toThrow("live-model session");
});

it("interactive startup applies explicit model flags to the restored session", async () => {
  const { runtime } = await fixture();
  const previous = await runtime.setModel(
    await runtime.session(),
    "openai",
    "gpt-6-luna",
  );
  await runtime.store.rememberSession(previous.id);
  const selected = await selectInitialSession(
    runtime,
    { provider: "openai", model: "gpt-6.1-sol" },
    defaultTuiPreferences,
  );
  expect(selected.id).toBe(previous.id);
  expect(selected.modelSelection?.model).toBe("gpt-6.1-sol");
});

it("keeps active settings isolated and initializes only new sessions from defaults", async () => {
  const { runtime } = await fixture();
  const a = await runtime.session(),
    b = await runtime.session();
  const agentA = await runtime.agent(a),
    agentB = await runtime.agent(b);
  const active = await runtime.setModel(a, "openai", "gpt-6.1-sol", {
    contextWindow: 64000,
    reasoning: "high",
    speed: "priority",
  });
  expect(await runtime.agent(active)).toBe(agentA);
  expect(agentA.options.provider.contextWindow).toBe(64000);
  expect(agentB.options.provider.contextWindow).toBe(128000);
  expect((await runtime.session(b.id)).modelSelection?.settings).toEqual({});
  expect(runtime.defaultSelection().settings).toEqual({});
  await runtime.saveDefaultSelection({
    ...active.modelSelection!,
    settings: { contextWindow: 32000, reasoning: "low", speed: "flex" },
  });
  expect(agentA.options.provider.contextWindow).toBe(64000);
  expect(agentB.options.provider.contextWindow).toBe(128000);
  const c = await runtime.session();
  expect(c.modelSelection?.settings).toEqual({
    contextWindow: 32000,
    reasoning: "low",
    speed: "flex",
  });
  expect((await runtime.agent(c)).options.provider.contextWindow).toBe(32000);
  await (await runtime.agent(active)).prompt("Check active settings");
  expect(capture.requests.at(-1)?.options).toMatchObject({
    reasoningEffort: "high",
    serviceTier: "priority",
    sessionId: a.id,
  });
  expect((await runtime.store.messages(a.id)).at(-1)?.thinking).toBe(
    "A short reasoning summary.",
  );
  await (await runtime.agent(c)).prompt("Check default settings");
  expect(capture.requests.at(-1)?.options).toMatchObject({
    reasoningEffort: "low",
    serviceTier: "flex",
    sessionId: c.id,
  });
  // Another process holding B cannot block changing A or allow changing B.
  await runtime.store.acquire(b.id, "other-process");
  await expect(
    runtime.setModel(b, "openai", "gpt-6.1-sol", { contextWindow: 16000 }),
  ).rejects.toThrow("Stop the active run");
  expect(agentB.options.provider.contextWindow).toBe(128000);
  await runtime.store.release(b.id, "other-process");
  const changed = await runtime.setModel(active, "openai", "gpt-6-luna");
  expect(changed.modelSelection?.settings).toEqual({});
  expect(runtime.defaultSelection().settings.contextWindow).toBe(32000);
});

it("restores active settings after exit and preserves them through forks and compaction", async () => {
  const { runtime, home, cwd } = await fixture();
  const a = await runtime.session();
  const active = await runtime.setModel(a, "openai", "gpt-6.1-sol", {
    contextWindow: 64000,
    reasoning: "high",
    speed: "priority",
  });
  await runtime.saveDefaultSelection({
    ...active.modelSelection!,
    settings: { contextWindow: 32000 },
  });
  await runtime.store.append(a.id, "message", {
    message: { role: "user", text: "Keep this goal", timestamp: Date.now() },
  });
  const fork = await runtime.fork(active);
  expect(fork.modelSelection).toEqual(active.modelSelection);
  const compact = await runtime.compact(active);
  expect(compact.modelSelection).toEqual(active.modelSelection);
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
  const restarted = await Runtime.open({
    home,
    cwd,
    approve: async () => false,
  });
  runtimes.push(restarted);
  const resumed = await restarted.session(a.id);
  expect(resumed.modelSelection).toEqual(active.modelSelection);
  expect((await restarted.agent(resumed)).options.provider.contextWindow).toBe(
    64000,
  );
  expect((await restarted.session(undefined, true)).id).toBe(compact.id);
  const fresh = await restarted.session();
  expect(fresh.modelSelection?.settings.contextWindow).toBe(32000);
  expect(
    JSON.parse(await readFile(join(home, "model-selection.json"), "utf8"))
      .settings.contextWindow,
  ).toBe(32000);
  expect(
    (await restarted.store.events(a.id)).some(
      (e) =>
        e.type === "model.changed" &&
        (e.data.selection as ModelSelection).settings.contextWindow === 64000,
    ),
  ).toBe(true);
});

it("pins settings for legacy sessions and continues only the current workspace", async () => {
  const { runtime, cwd } = await fixture();
  const legacy = await runtime.store.createSession(cwd);
  const agent = await runtime.agent(legacy);
  expect((await runtime.session(legacy.id)).modelSelection).toEqual(
    agent.options.session.modelSelection,
  );
  await runtime.store.createSession(join(cwd, "other-workspace"));
  expect((await runtime.session(undefined, true)).id).toBe(legacy.id);
});

it("routes active, default, and Ctrl+S settings to distinct save actions", async () => {
  const active: ModelSelection = {
    provider: "openai",
    model: "active",
    settings: { contextWindow: 64000, reasoning: "high" },
  };
  const defaults: ModelSelection = {
    provider: "openai",
    model: "default",
    settings: { contextWindow: 128000, reasoning: "low" },
  };
  const run = async (
    choices: Array<string | { value: string; makeDefault: boolean }>,
  ) => {
    const applied: unknown[] = [],
      saved: ModelSelection[] = [],
      titles: string[] = [];
    const panel = {
      choose: async (title: string) => {
        titles.push(title);
        const choice = choices.shift();
        if (!choice) throw Error("Unexpected extra picker step");
        return typeof choice === "string"
          ? { value: choice, makeDefault: false }
          : choice;
      },
    };
    const view = {
      openModelPanel: () => ({
        panel,
        signal: new AbortController().signal,
        close() {},
      }),
      notice() {},
      setError(error: string) {
        throw Error(error);
      },
    } as unknown as HikaroView;
    const catalog = {
      capabilities: async () => ({
        contextWindow: 128000,
        reasoning: ["low", "high"],
        speed: ["default", "priority"],
      }),
    } as unknown as ProviderCatalog;
    await openModelControl(
      view,
      catalog,
      "context",
      active,
      defaults,
      async (settings) => {
        applied.push({ ...settings });
      },
      async (selection) => {
        saved.push(selection);
      },
    );
    return { applied, saved, titles };
  };
  const local = await run(["32000"]);
  expect(local.applied).toEqual([{ contextWindow: 32000, reasoning: "high" }]);
  expect(local.saved).toEqual([]);
  const global = await run(["__scope", "16000"]);
  expect(global.applied).toEqual([]);
  expect(global.saved).toEqual([
    { ...defaults, settings: { contextWindow: 16000, reasoning: "low" } },
  ]);
  expect(global.titles).toContain("/context · default · openai/default");
  const both = await run([{ value: "64000", makeDefault: true }]);
  expect(both.applied).toEqual([active.settings]);
  expect(both.saved).toEqual([active]);
  expect(active.settings.contextWindow).toBe(64000);
  expect(defaults.settings.contextWindow).toBe(128000);
});

it("inherits saved defaults with matching CLI model flags and when leaving demo mode", async () => {
  const { runtime, home, cwd } = await fixture();
  await runtime.saveDefaultSelection({
    provider: "openai",
    model: "gpt-6.1-sol",
    settings: { contextWindow: 64000, reasoning: "high" },
  });
  const flagged = await Runtime.open({
    home,
    cwd,
    provider: "openai",
    model: "gpt-6.1-sol",
    approve: async () => false,
  });
  runtimes.push(flagged);
  expect((await flagged.session()).modelSelection?.settings).toEqual({
    contextWindow: 64000,
    reasoning: "high",
  });
  const demo = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  runtimes.push(demo);
  const initial = await demo.session();
  expect(initial.modelSelection?.settings).toEqual({});
  const switched = await demo.setModel(initial, "openai", "gpt-6.1-sol");
  expect(switched.modelSelection?.settings).toEqual({
    contextWindow: 64000,
    reasoning: "high",
  });
  expect((await demo.agent(switched)).options.provider.contextWindow).toBe(
    64000,
  );
  expect((await demo.session()).modelSelection?.provider).toBe("openai");
});

it("constructs real SDK request bodies with reasoning and speed settings, without network access", async () => {
  const { createPiProvider } =
    await import("../packages/provider-pi/src/index.ts");
  capture.native = true;
  for (const settings of [
    { reasoning: "high", speed: "priority" },
    { reasoning: "off", speed: "default" },
  ] as const) {
    const adapter = await createPiProvider({
      provider: "openai",
      model: "gpt-6.1-sol",
      settings: { ...settings, contextWindow: 64000 },
    });
    expect(adapter.contextWindow).toBe(64000);
    await expect(
      (async () => {
        for await (const _event of adapter.stream({
          system: "Test",
          messages: [{ role: "user", text: "Hello", timestamp: 1 }],
          tools: [],
          signal: new AbortController().signal,
          sessionId: "offline-session",
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("Offline request captured");
    const body = capture.bodies.at(-1);
    expect(body.reasoning.effort).toBe(
      settings.reasoning === "off" ? "none" : "high",
    );
    expect(body.service_tier).toBe(
      settings.speed === "priority" ? "priority" : undefined,
    );
    expect(body.max_output_tokens).toBeLessThanOrEqual(64000 * 0.35);
  }
  expect(capture.bodies).toHaveLength(2);
});

it("deletes session history and outputs, preserves branches and refuses a live session", async () => {
  const { runtime, home } = await fixture();
  const session = await runtime.session();
  await runtime.store.append(session.id, "message", {
    message: { role: "user", text: "Delete only this session", timestamp: 1 },
  });
  const branch = await runtime.fork(session);
  await runtime.store.acquire(session.id, "running-owner");
  await expect(runtime.deleteSession(session.id)).rejects.toThrow(
    "Stop the active run",
  );
  await runtime.store.release(session.id, "running-owner");
  const folder = join(home, "artifacts", session.id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "sample.json"), "{}");
  await runtime.deleteSession(session.id);
  expect(await runtime.store.session(session.id)).toBeUndefined();
  expect(await runtime.store.events(session.id)).toEqual([]);
  await expect(readFile(join(folder, "sample.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await runtime.store.acquire(session.id, "late-owner")).toBe(false);
  expect((await runtime.store.messages(branch.id))[0]?.text).toBe(
    "Delete only this session",
  );
  expect((await runtime.session(branch.id)).parentId).toBeNull();
});

it("uses Delete in the session picker and deletes only after confirmation", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  const result = panel.choose(
    "Sessions",
    [{ value: "a", label: "A" }],
    "",
    "",
    { allowDelete: true },
  );
  panel.handleInput("\x1b[3~");
  expect(await result).toMatchObject({ value: "a", action: "delete" });
  const cancel = panel.choose(
    "Delete A?",
    [{ value: "delete", label: "Delete session" }],
    "",
    "Enter delete · Esc cancel",
    { cancelValue: "__cancel" },
  );
  expect(panel.cancelStep()).toBe(true);
  expect(await cancel).toMatchObject({ value: "__cancel" });
  const confirm = panel.choose("Delete A?", [
    { value: "delete", label: "Delete session" },
  ]);
  panel.handleInput("\r");
  expect(await confirm).toMatchObject({ value: "delete" });
  const selection = { id: "a", cwd: "/workspace", title: "A", createdAt: 1 };
  const steps = [
    { value: "a", action: "delete" },
    { value: "__cancel" },
    { value: "a", action: "delete" },
    { value: "delete" },
    { value: "b" },
  ];
  const removed: string[] = [],
    resumed: string[] = [];
  const view = {
    openModelPanel: () => ({
      panel: {
        progress: () => {},
        choose: async () => ({ ...steps.shift(), makeDefault: false }),
      },
      signal: abort.signal,
      close() {},
    }),
    setError(error: string) {
      throw Error(error);
    },
  } as unknown as HikaroView;
  await openSessions(
    view,
    () => "a",
    async () => [selection, { ...selection, id: "b" }],
    async (id) => {
      resumed.push(id);
    },
    async (id) => {
      removed.push(id);
      return undefined;
    },
  );
  expect(removed).toEqual(["a"]);
  expect(resumed).toEqual(["b"]);
});

it("defaults startup to resume and migrates the old serialized startup default", async () => {
  const { home } = await fixture();
  expect((await loadTuiPreferences(home)).resumeOnStart).toBe(true);
  await writeFile(
    join(home, "tui-preferences.json"),
    JSON.stringify({ resumeOnStart: false, showThinking: true }),
  );
  expect(await loadTuiPreferences(home)).toMatchObject({
    version: 2,
    resumeOnStart: true,
    showThinking: true,
  });
  await saveTuiPreferences(home, {
    ...defaultTuiPreferences,
    resumeOnStart: false,
  });
  expect((await loadTuiPreferences(home)).resumeOnStart).toBe(false);
});

it("restores the last opened session instead of the newest background session", async () => {
  const { runtime } = await fixture();
  const opened = await runtime.session();
  await runtime.store.rememberSession(opened.id);
  await runtime.session();
  expect((await runtime.session(undefined, true)).id).toBe(opened.id);
});

it("can delete the last session and start a fresh blank session", async () => {
  const { runtime } = await fixture();
  const last = await runtime.session();
  await runtime.store.rememberSession(last.id);
  await runtime.store.saveDraft(last.id, "Unsent draft");
  await runtime.deleteSession(last.id);
  expect(await runtime.store.sessions()).toEqual([]);
  expect(await runtime.store.lastSession(runtime.options.cwd)).toBeUndefined();
  expect(await runtime.store.draft(last.id)).toBe("");
  const fresh = await runtime.session(undefined, true);
  expect(fresh.id).not.toBe(last.id);
  expect(await runtime.store.messages(fresh.id)).toEqual([]);
});

it("persists drafts independently and retains them through session renaming", async () => {
  const { runtime, home } = await fixture();
  const a = await runtime.session(),
    b = await runtime.session();
  await runtime.store.saveDraft(a.id, "Unsent 中文 draft");
  await runtime.renameSession(a.id, "Renamed session");
  const { SQLiteStore } = await import("../packages/storage/src/index.ts");
  const reopened = await SQLiteStore.open(join(home, "sessions.sqlite"));
  try {
    expect(await reopened.draft(a.id)).toBe("Unsent 中文 draft");
    expect(await reopened.draft(b.id)).toBe("");
    expect((await reopened.session(a.id))?.title).toBe("Renamed session");
  } finally {
    await reopened.close();
  }
});

it("exports all message pages without including hidden thinking by default", async () => {
  const { runtime } = await fixture();
  const session = await runtime.session();
  for (let n = 0; n < 101; n++)
    await runtime.store.append(session.id, "message", {
      message: {
        role: n % 2 ? "assistant" : "user",
        text: `Export row ${n}`,
        thinking: n % 2 ? "Hidden thinking" : undefined,
        timestamp: n,
      },
    });
  const text = await readFile(await runtime.exportSession(session.id), "utf8");
  expect(text).toContain("Export row 0");
  expect(text).toContain("Export row 100");
  expect(text).not.toContain("Hidden thinking");
});

it("paginates sessions and exposes rename in the session picker", async () => {
  const sessions = Array.from({ length: 51 }, (_, n) => ({
    id: `id${n}`,
    title: `Title ${n}`,
    cwd: "/workspace",
    createdAt: n,
  }));
  const steps = [
    { value: "__next" },
    { value: "id50", action: "rename" },
    { value: "id50" },
  ];
  const offsets: number[] = [],
    renamed: string[] = [],
    resumed: string[] = [];
  const view = {
    openModelPanel: () => ({
      panel: {
        progress: () => {},
        choose: async () => ({ ...steps.shift(), makeDefault: false }),
        prompt: async () => "New title",
      },
      signal: new AbortController().signal,
      close() {},
    }),
    setError(error: string) {
      throw Error(error);
    },
  } as unknown as HikaroView;
  await openSessions(
    view,
    () => "id0",
    async (offset, limit) => {
      offsets.push(offset);
      return sessions.slice(offset, offset + limit);
    },
    async (id) => {
      resumed.push(id);
    },
    async () => undefined,
    async (id, title) => {
      renamed.push(id + ":" + title);
    },
  );
  expect(offsets).toEqual([0, 50, 50]);
  expect(renamed).toEqual(["id50:New title"]);
  expect(resumed).toEqual(["id50"]);
});

it("saves general settings immediately and restores them on startup", async () => {
  const { home } = await fixture();
  const abort = new AbortController();
  let count = 0;
  const saved: unknown[] = [];
  const view = {
    openModelPanel: () => ({
      panel: {
        choose: async () => {
          if (count++) {
            abort.abort();
            throw new DOMException("Close", "AbortError");
          }
          return { value: "showThinking", makeDefault: false };
        },
      },
      signal: abort.signal,
      close() {},
    }),
    setError(error: string) {
      throw Error(error);
    },
  } as unknown as HikaroView;
  await openGeneralSettings(view, defaultTuiPreferences, async (next) => {
    await saveTuiPreferences(home, next);
    saved.push(next);
  });
  expect(saved).toHaveLength(1);
  expect((await loadTuiPreferences(home)).showThinking).toBe(true);
  expect((await loadTuiPreferences(home)).showUsage).toBe(true);
});

it("interactive startup applies an explicit compatible endpoint when restoring another provider", async () => {
  const { runtime, home, cwd } = await fixture();
  const previous = await runtime.session();
  await runtime.store.rememberSession(previous.id);
  const baseUrl = "http://localhost:11434/v1";
  const local = await Runtime.open({
    home,
    cwd,
    provider: "local",
    model: "local-test",
    baseUrl,
    approve: async () => false,
  });
  runtimes.push(local);
  const selected = await selectInitialSession(
    local,
    { provider: "local", model: "local-test", baseUrl },
    defaultTuiPreferences,
  );
  expect(selected.id).toBe(previous.id);
  expect(selected.modelSelection).toMatchObject({
    provider: "local",
    model: "local-test",
    baseUrl,
  });
  expect((await local.agent(selected)).options.provider.model).toBe(
    "local-test",
  );
});
