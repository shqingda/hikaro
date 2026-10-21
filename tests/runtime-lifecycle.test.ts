import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import type { ProviderAdapter } from "../packages/core/src/index.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const runtimes = new Set<Runtime>();
const folders: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});

async function fixture(workspace?: string) {
  const home = await mkdtemp(join(tmpdir(), "hikaro-lifecycle-"));
  folders.push(home);
  const cwd = workspace ? join(home, workspace) : home;
  if (workspace) await mkdir(cwd);
  const calls: string[] = [];
  const provider: ProviderAdapter = {
    id: "controlled",
    model: "test",
    contextWindow: 32000,
    async *stream(input) {
      calls.push(input.sessionId!);
      yield {
        type: "done",
        message: { role: "assistant", text: "Finished", timestamp: 1 },
        usage: { input: 1, output: 1, cost: 0 },
      };
    },
  };
  const runtime = await Runtime.open({
    home,
    cwd,
    provider: provider.id,
    model: provider.model,
    approve: async () => false,
  });
  runtimes.add(runtime);
  runtime.plugins.providers.set(provider.id, async () => provider);
  return { runtime, home, provider, calls };
}

it.each(["workspace", 'quoted "files"\nnot-an-instruction'])(
  "includes the actual workspace directory as quoted context: %s",
  async (workspace) => {
    const { runtime, provider } = await fixture(workspace);
    let system = "";
    const original = provider.stream;
    provider.stream = async function* (input) {
      system = input.system;
      yield* original(input);
    };
    const session = await runtime.session();
    await (await runtime.agent(session)).prompt("Read the local project");
    expect(system).toContain(
      "Workspace directory (JSON string): " + JSON.stringify(session.cwd),
    );
    expect(system).toContain(
      "Relative file paths resolve inside this workspace",
    );
    expect(system).not.toContain("\nnot-an-instruction");
  },
);

it("does not start a child cancelled while its provider initializes", async () => {
  const { runtime, provider, calls } = await fixture();
  const parent = await runtime.agent(await runtime.session());
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => {
    entered.resolve();
    await release.promise;
    return provider;
  });
  const abort = new AbortController();
  const child = parent.invoke("subagent", { task: "Child task" }, abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve();
  expect((await child).isError).toBe(true);
  expect(calls).toEqual([]);
  const sessions = await runtime.store.sessions();
  const childSession = sessions.find((session) => session.parentId);
  expect(childSession).toBeDefined();
  expect(await runtime.store.messages(childSession!.id)).toEqual([]);
});

it("reserves the subagent limit before asynchronous initialization", async () => {
  const { runtime, provider, calls } = await fixture();
  const parent = await runtime.agent(await runtime.session());
  const initialized = deferred(),
    release = deferred();
  let starts = 0,
    settled = 0;
  const checkpoint = () => {
    if (starts + settled === 5) initialized.resolve();
  };
  runtime.plugins.providers.set(provider.id, async () => {
    starts++;
    checkpoint();
    await release.promise;
    return provider;
  });
  const children = Array.from({ length: 5 }, (_, index) =>
    parent
      .invoke(
        "subagent",
        { task: `Child ${index}` },
        new AbortController().signal,
      )
      .then((result) => {
        settled++;
        checkpoint();
        return result;
      }),
  );
  await initialized.promise;
  release.resolve();
  const results = await Promise.all(children);
  expect(
    results.filter((result) => result.isError).map((result) => result.text),
  ).toEqual(["Agent concurrency limit reached"]);
  expect(calls).toHaveLength(4);
  expect(
    (
      await parent.invoke(
        "subagent",
        { task: "Next child" },
        new AbortController().signal,
      )
    ).isError,
  ).not.toBe(true);
});

it("keeps a scheduled task interrupted when stopped during initialization", async () => {
  const { runtime, home, provider, calls } = await fixture();
  const session = await runtime.session();
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => {
    entered.resolve();
    await release.promise;
    return provider;
  });
  await runtime.store.putJob({
    id: randomUUID(),
    sessionId: session.id,
    task: "Scheduled task",
    runAt: Date.now() - 1,
    state: "queued",
  });
  runtime.startJobs();
  await entered.promise;
  const closing = runtime.close();
  release.resolve();
  await closing;
  runtimes.delete(runtime);
  const saved = await SQLiteStore.open(join(home, "sessions.sqlite"));
  try {
    expect((await saved.jobs())[0]?.state).toBe("interrupted");
    expect(calls).toEqual([]);
  } finally {
    await saved.close();
  }
});

it("shares one Agent when the same session initializes concurrently", async () => {
  const { runtime, provider } = await fixture();
  const session = await runtime.session();
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => {
    entered.resolve();
    await release.promise;
    return provider;
  });
  const first = runtime.agent(session),
    second = runtime.agent(session);
  await entered.promise;
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
});

it("does not start compaction cancelled while its Agent initializes", async () => {
  const { runtime, provider, calls } = await fixture();
  const session = await runtime.session();
  await runtime.store.append(session.id, "message", {
    message: { role: "user", text: "Prior task", timestamp: 1 },
  });
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => {
    entered.resolve();
    await release.promise;
    return provider;
  });
  const abort = new AbortController();
  const compacting = runtime.compact(session, abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve();
  await expect(compacting).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([]);
  expect(await runtime.store.sessions()).toHaveLength(1);
});

it("cancels running compaction without saving a continuation", async () => {
  const { runtime, provider } = await fixture();
  const session = await runtime.session();
  await runtime.store.append(session.id, "message", {
    message: { role: "user", text: "Prior task", timestamp: 1 },
  });
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => ({
    ...provider,
    async *stream(input) {
      entered.resolve();
      await release.promise;
      yield* provider.stream(input);
    },
  }));
  const abort = new AbortController();
  const compacting = runtime.compact(session, abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve();
  await expect(compacting).rejects.toMatchObject({ name: "AbortError" });
  expect(await runtime.store.sessions()).toHaveLength(1);
  const events = await runtime.store.events(session.id);
  expect(
    events.filter((event) => event.type === "run.end").at(-1)?.data.status,
  ).toBe("cancelled");
});

it("rejects unfinished Agent initialization when the Runtime closes", async () => {
  const { runtime, provider } = await fixture();
  const session = await runtime.session();
  const entered = deferred(),
    release = deferred();
  runtime.plugins.providers.set(provider.id, async () => {
    entered.resolve();
    await release.promise;
    return provider;
  });
  const initializing = runtime.agent(session);
  const result = expect(initializing).rejects.toThrow("Runtime is closing");
  await entered.promise;
  const closing = runtime.close();
  release.resolve();
  await result;
  await closing;
  runtimes.delete(runtime);
  await expect(runtime.agent(session)).rejects.toThrow("Runtime is closing");
});

it("releases all subagent reservations when provider initialization fails", async () => {
  const { runtime, provider } = await fixture();
  const parent = await runtime.agent(await runtime.session());
  runtime.plugins.providers.set(provider.id, async () => {
    throw Error("Provider unavailable");
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      parent.invoke(
        "subagent",
        { task: "Child" },
        new AbortController().signal,
      ),
    ),
  );
  expect(results.map((result) => result.text)).toEqual(
    Array(4).fill("Provider unavailable"),
  );
  runtime.plugins.providers.set(provider.id, async () => provider);
  expect(
    (
      await parent.invoke(
        "subagent",
        { task: "Recovered" },
        new AbortController().signal,
      )
    ).isError,
  ).not.toBe(true);
});

it.each([
  ["permissions", "Finish or cancel the run before changing permissions."],
  ["model", "Stop active runs before changing model"],
  ["deletion", "Stop the active run before deleting this session"],
] as const)(
  "blocks %s changes during Agent initialization",
  async (operation, message) => {
    const { runtime, provider } = await fixture();
    const session = await runtime.session();
    const entered = deferred(),
      release = deferred();
    let first = true;
    runtime.plugins.providers.set(provider.id, async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return provider;
    });
    const initializing = runtime.agent(session);
    await entered.promise;
    let failure: string | undefined;
    try {
      if (operation === "permissions") await runtime.setPermissionMode("full");
      if (operation === "model")
        await runtime.setModel(session, provider.id, "replacement");
      if (operation === "deletion") await runtime.deleteSession(session.id);
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      release.resolve();
      await initializing.catch(() => {});
    }
    expect(failure).toBe(message);
    expect((await runtime.session(session.id)).modelSelection?.model).toBe(
      provider.model,
    );
  },
);
