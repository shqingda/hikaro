import { afterEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { Runtime, type RuntimeOptions } from "../packages/runtime/src/index.ts";
import { serveRpc } from "../packages/cli/src/rpc.ts";
import type { Session } from "../packages/core/src/index.ts";
import type { SQLiteStore } from "../packages/storage/src/index.ts";
import { ResolvedFrame } from "../packages/protocol/src/contracts.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function connection() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: any[] = [];
  output.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n"))
      messages.push(JSON.parse(line));
  });
  let approve!: NonNullable<RuntimeOptions["approve"]>;
  const sessions = new Map<string, Session>();
  const agents = new Map<
    string,
    {
      cancelled: boolean;
      cancel: () => void;
      prompt: () => Promise<void>;
      enqueuePrompt: () => Promise<{ completion: Promise<void> }>;
      snapshot: () => {
        busy: boolean;
        runId: string | null;
        runStatus: "idle" | "running" | "completed";
      };
      subscribe: () => () => void;
    }
  >();
  const compact = deferred<Session>();
  const run = deferred();
  const runtime = {
    options: { cwd: "/workspace" },
    store: {
      sessions: vi.fn(async () => [...sessions.values()]),
      acceptCommand: vi.fn(
        async (
          command: Parameters<SQLiteStore["acceptCommand"]>[0],
        ): ReturnType<SQLiteStore["acceptCommand"]> => ({
          inserted: true,
          receipt: {
            ...command,
            status: "accepted" as const,
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      ),
      finishCommand: vi.fn(
        async (_outcome: Parameters<SQLiteStore["finishCommand"]>[0]) => {},
      ),
    },
    startJobs() {},
    async session(id?: string) {
      if (id) return sessions.get(id)!;
      const session = {
        id: `session-${sessions.size}`,
        title: "",
        cwd: "/workspace",
        createdAt: 0,
      };
      sessions.set(session.id, session);
      return session;
    },
    async agent(session: Session) {
      let agent = agents.get(session.id);
      if (!agent) {
        agent = {
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
          prompt: () => run.promise,
          async enqueuePrompt() {
            return { completion: this.prompt() };
          },
          snapshot: () => ({ busy: false, runId: null, runStatus: "idle" }),
          subscribe: () => () => {},
        };
        agents.set(session.id, agent);
      }
      return agent;
    },
    compact: vi.fn(() =>
      compact.promise.then((session) => {
        sessions.set(session.id, session);
        return session;
      }),
    ),
    async close() {
      run.resolve();
      compact.resolve([...sessions.values()][0]!);
    },
  };
  vi.spyOn(Runtime, "open").mockImplementation(async (options) => {
    approve = options.approve!;
    return runtime as unknown as Runtime;
  });
  const server = await serveRpc(
    { cwd: "/workspace", demo: true },
    {
      input,
      output,
      error: new PassThrough(),
    },
  );
  cleanups.push(() => server.close());
  let nextId = 0;
  const send = (
    method: string,
    scope = "a",
    params: Record<string, unknown> = {},
  ) => {
    const id = `command-${nextId++}`;
    input.write(JSON.stringify({ id, scope, method, params }) + "\n");
    return id;
  };
  const reply = (id: string) =>
    messages.find(
      (message) => message.type === "response" && message.id === id,
    );
  const request = async (
    method: string,
    scope = "a",
    params: Record<string, unknown> = {},
  ) => {
    const id = send(method, scope, params);
    await setImmediate();
    expect(reply(id), `response to ${method}`).toBeDefined();
    expect(reply(id).error).toBeUndefined();
    return reply(id).result;
  };
  return {
    agents,
    compact,
    messages,
    request,
    send,
    reply,
    runtime,
    approve: (...args: Parameters<typeof approve>) => approve(...args),
  };
}

it("accepts compaction immediately and keeps cancellation and other scopes responsive", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  await rpc.request("session.create", "b");
  const compaction = rpc.send("session.compact");
  await setImmediate();
  expect(rpc.runtime.compact).toHaveBeenCalled();
  expect(rpc.reply(compaction)?.result).toEqual({
    accepted: true,
    operationId: expect.any(String),
  });
  const current = await rpc.request("session.current", "b");
  expect(current.session.id).not.toBe(session.id);
  await rpc.request("cancel");
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
});

it("fences run cancellation after the durable claim and records the targeted run", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const agent = rpc.agents.get(session.id)!;
  const active = { busy: true, runId: "run-1", runStatus: "running" as const };
  agent.snapshot = () => active;
  const claim = deferred<Awaited<ReturnType<SQLiteStore["acceptCommand"]>>>();
  const accept = rpc.runtime.store.acceptCommand.getMockImplementation()!;
  rpc.runtime.store.acceptCommand.mockImplementationOnce(() => claim.promise);
  const stale = rpc.send("run.cancel", "a", {
    sessionId: session.id,
    runId: "run-1",
  });
  await setImmediate();
  active.runId = "run-2";
  const command = rpc.runtime.store.acceptCommand.mock.calls.find(
    ([item]) => item.method === "run.cancel",
  )?.[0];
  expect(command).toBeDefined();
  claim.resolve(await accept(command!));
  await setImmediate();
  expect(rpc.reply(stale)?.error).toMatch(/no longer active/i);
  expect(agent.cancelled).toBe(false);
  const other = rpc.send("run.cancel", "a", {
    sessionId: "other",
    runId: "run-2",
  });
  await setImmediate();
  expect(rpc.reply(other)?.error).toMatch(/selected session/i);
  expect(agent.cancelled).toBe(false);
  const listing = deferred<Session[]>();
  rpc.runtime.store.sessions.mockImplementationOnce(() => listing.promise);
  const blocked = rpc.send("session.list");
  await setImmediate();
  expect(rpc.reply(blocked)).toBeUndefined();
  try {
    expect(
      await rpc.request("run.cancel", "a", {
        sessionId: session.id,
        runId: "run-2",
      }),
    ).toEqual({ accepted: true, runId: "run-2" });
  } finally {
    listing.resolve([session]);
  }
  expect(agent.cancelled).toBe(true);
  const stopped = rpc.runtime.store.acceptCommand.mock.calls.at(-1)![0];
  expect(
    rpc.runtime.store.finishCommand.mock.calls.filter(
      ([outcome]) => outcome.id === stopped.id,
    ),
  ).toHaveLength(1);
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "completed",
      sessionId: session.id,
      runId: "run-2",
    }),
  );
  agent.cancelled = false;
  agent.snapshot = () => ({
    busy: false,
    runId: "run-2",
    runStatus: "completed",
  });
  const ended = rpc.send("run.cancel", "a", {
    sessionId: session.id,
    runId: "run-2",
  });
  await setImmediate();
  expect(rpc.reply(ended)?.error).toMatch(/no longer active/i);
  expect(agent.cancelled).toBe(false);
});

it("delivers compaction completion through scoped operation events", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const accepted = await rpc.request("session.compact");
  const claim = rpc.runtime.store.acceptCommand.mock.calls.find(
    ([command]) => command.method === "session.compact",
  )![0];
  expect(rpc.runtime.store.finishCommand).not.toHaveBeenCalledWith(
    expect.objectContaining({ id: claim.id }),
  );
  const continuation = { ...session, id: "continuation" };
  rpc.compact.resolve(continuation);
  await setImmediate();
  expect(rpc.messages).toContainEqual({
    type: "operation.completed",
    scope: "a",
    operationId: accepted.operationId,
    method: "session.compact",
    result: continuation,
    hostInstanceId: expect.any(String),
  });
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      id: claim.id,
      scope: "a",
      status: "completed",
      sessionId: continuation.id,
      operationId: accepted.operationId,
    }),
  );
  expect((await rpc.request("session.current")).session.id).toBe(
    "continuation",
  );
});

it("reports failed compaction without failing later requests", async () => {
  const rpc = await connection();
  await rpc.request("session.create");
  const accepted = await rpc.request("session.compact");
  const claim = rpc.runtime.store.acceptCommand.mock.calls.find(
    ([command]) => command.method === "session.compact",
  )![0];
  rpc.compact.reject(Error("Summary unavailable"));
  await setImmediate();
  expect(rpc.messages).toContainEqual({
    type: "operation.failed",
    scope: "a",
    operationId: accepted.operationId,
    method: "session.compact",
    error: "Summary unavailable",
    hostInstanceId: expect.any(String),
  });
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      id: claim.id,
      status: "failed",
      operationId: accepted.operationId,
      error: expect.stringContaining("Summary unavailable"),
    }),
  );
  expect((await rpc.request("session.current")).session).toBeTruthy();
});

it("continues ordinary requests in another scope while one scope is blocked", async () => {
  const rpc = await connection();
  await rpc.request("session.create");
  const listing = deferred<Session[]>();
  rpc.runtime.store.sessions.mockImplementation(() => listing.promise);
  rpc.send("session.list");
  await setImmediate();
  expect((await rpc.request("session.create", "b")).id).toBeTruthy();
  listing.resolve([]);
});

it("cancels compaction while its agent is being initialized", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const agent = rpc.agents.get(session.id)!;
  const ready = deferred<typeof agent>();
  vi.spyOn(rpc.runtime, "agent").mockImplementation(() => ready.promise);
  const compact = rpc.send("session.compact");
  await setImmediate();
  await rpc.request("cancel");
  ready.resolve(agent);
  await setImmediate();
  expect(rpc.reply(compact)?.error).toMatch(/cancelled/i);
  expect(rpc.runtime.compact).not.toHaveBeenCalled();
});

it("does not select a continuation produced after cancellation", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const accepted = await rpc.request("session.compact");
  await rpc.request("cancel");
  rpc.compact.resolve({ ...session, id: "continuation" });
  await setImmediate();
  expect((await rpc.request("session.current")).session.id).toBe(session.id);
  expect(
    rpc.messages.some(
      (message) =>
        message.type === "operation.failed" &&
        message.operationId === accepted.operationId,
    ),
  ).toBe(true);
});

it("does not replace a newer selection after compaction completes", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  await rpc.request("session.compact");
  const newer = await rpc.request("session.create");
  rpc.compact.resolve({ ...session, id: "continuation" });
  await setImmediate();
  expect((await rpc.request("session.current")).session.id).toBe(newer.id);
});

it("does not replace a newer selection while initializing the continuation agent", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const continuation = { ...session, id: "continuation" };
  const continuationAgent = await rpc.runtime.agent(continuation);
  const ready = deferred<typeof continuationAgent>();
  const agentFor = rpc.runtime.agent.bind(rpc.runtime);
  vi.spyOn(rpc.runtime, "agent").mockImplementation((selected) =>
    selected.id === continuation.id ? ready.promise : agentFor(selected),
  );
  await rpc.request("session.compact");
  rpc.compact.resolve(continuation);
  await setImmediate();
  const newer = await rpc.request("session.create");
  ready.resolve(continuationAgent);
  await setImmediate();
  expect((await rpc.request("session.current")).session.id).toBe(newer.id);
});

it("rejects a prompt cancelled while its persistent claim is pending", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const claim = deferred<Awaited<ReturnType<SQLiteStore["acceptCommand"]>>>();
  const accept = rpc.runtime.store.acceptCommand.getMockImplementation()!;
  rpc.runtime.store.acceptCommand.mockImplementationOnce(() => claim.promise);
  const prompt = rpc.send("prompt", "a", { text: "first" });
  await setImmediate();
  await rpc.request("cancel");
  const pendingCommand = rpc.runtime.store.acceptCommand.mock.calls.find(
    ([command]) => command.id === prompt,
  )![0];
  claim.resolve(await accept(pendingCommand));
  await setImmediate();
  expect(rpc.reply(prompt)?.error).toMatch(/cancelled/i);
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      id: prompt,
      status: "failed",
      error: expect.stringMatching(/cancelled/i),
    }),
  );
});

it("processes approval replies and detaches while ordinary commands are blocked", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  await rpc.request("prompt", "a", { text: "active" });
  const listing = deferred<Session[]>();
  rpc.runtime.store.sessions.mockImplementation(() => listing.promise);
  rpc.send("session.list");
  await setImmediate();
  const allowed = rpc.approve(
    {
      id: "approval",
      scope: "a",
      sessionId: session.id,
      tool: "shell",
      reason: "test",
      arguments: {},
    },
    new AbortController().signal,
  );
  await rpc.request("approval.respond", "a", { id: "approval", allow: true });
  expect(await allowed).toBe(true);
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
  listing.resolve([]);
});

it("resolves pending approvals with a valid revision before detaching the scope", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const allowed = rpc.approve(
    {
      id: "pending-at-detach",
      scope: "a",
      sessionId: session.id,
      tool: "shell",
      reason: "test",
      arguments: {},
    },
    new AbortController().signal,
  );
  const requested = rpc.messages.find((frame) => frame.type === "approval");
  await rpc.request("client.detach");
  expect(await allowed).toBe(false);
  const resolved = rpc.messages.find(
    (frame) => frame.type === "approval.resolved",
  );
  expect(ResolvedFrame.parse(resolved)).toMatchObject({
    id: "pending-at-detach",
    allow: false,
    revision: requested.revision + 1,
  });
});

it("revoking a scope that only viewed another scope's session leaves that run active", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create", "b");
  await rpc.request("prompt", "b", { text: "active" });
  await rpc.request("session.resume", "a", { sessionId: session.id });
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(session.id)?.cancelled).toBe(false);
});

it("restores approvals raised by surviving work after a view detached", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  await rpc.request("client.detach");
  const allowed = rpc.approve(
    {
      id: "after-detach",
      scope: "a",
      sessionId: session.id,
      tool: "shell",
      reason: "test",
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(rpc.messages.some((frame) => frame.type === "approval")).toBe(false);
  const current = await rpc.request("session.current");
  expect(current.approvals).toMatchObject([{ id: "after-detach" }]);
  await rpc.request("approval.respond", "a", {
    id: "after-detach",
    allow: false,
  });
  expect(await allowed).toBe(false);
  const resolved = rpc.messages.find(
    (frame) => frame.type === "approval.resolved",
  );
  expect(ResolvedFrame.parse(resolved)).toMatchObject({ revision: 1 });
});

it("detaching cancels runs owned by the scope even after selecting another session", async () => {
  const rpc = await connection();
  const first = await rpc.request("session.create");
  await rpc.request("prompt", "a", { text: "first" });
  const second = await rpc.request("session.create");
  await rpc.request("prompt", "a", { text: "second" });
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(first.id)?.cancelled).toBe(true);
  expect(rpc.agents.get(second.id)?.cancelled).toBe(true);
});

it("revoking a detached scope cancels its surviving runs", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  await rpc.request("prompt", "a", { text: "surviving" });
  await rpc.request("client.detach");
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
});

it("retains ownership until all queued prompts for an older session settle", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const first = deferred();
  const second = deferred();
  vi.spyOn(rpc.agents.get(session.id)!, "prompt")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await rpc.request("prompt", "a", { text: "first" });
  await rpc.request("prompt", "a", { text: "second" });
  const promptIds = rpc.runtime.store.acceptCommand.mock.calls
    .filter(([command]) => command.method === "prompt")
    .map(([command]) => command.id);
  expect(rpc.runtime.store.finishCommand).not.toHaveBeenCalledWith(
    expect.objectContaining({ id: promptIds[0] }),
  );
  await rpc.request("session.create");
  first.resolve();
  await setImmediate();
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      id: promptIds[0],
      status: "completed",
      sessionId: session.id,
    }),
  );
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
  second.resolve();
  await setImmediate();
  expect(rpc.runtime.store.finishCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      id: promptIds[1],
      status: "completed",
      sessionId: session.id,
    }),
  );
});

it("rejects excess queued requests while allowing control and other scopes", async () => {
  const rpc = await connection();
  await rpc.request("session.create");
  const listing = deferred<Session[]>();
  rpc.runtime.store.sessions.mockImplementation(() => listing.promise);
  rpc.send("session.list");
  await setImmediate();
  const commands = Array.from({ length: 200 }, () => rpc.send("session.list"));
  await setImmediate();
  expect(
    commands.some((id) => /capacity/i.test(rpc.reply(id)?.error ?? "")),
  ).toBe(true);
  await rpc.request("cancel");
  expect((await rpc.request("session.current", "b")).session).toBeNull();
  listing.resolve([]);
});

it("bounds queued request bytes as well as the request count", async () => {
  const rpc = await connection();
  await rpc.request("session.create");
  const listing = deferred<Session[]>();
  rpc.runtime.store.sessions.mockImplementation(() => listing.promise);
  rpc.send("session.list");
  await setImmediate();
  const commands = Array.from({ length: 4 }, () =>
    rpc.send("session.list", "a", { unused: "x".repeat(700_000) }),
  );
  await setImmediate();
  expect(
    commands.some((id) => /capacity/i.test(rpc.reply(id)?.error ?? "")),
  ).toBe(true);
  listing.resolve([]);
});

it("bounds waiting control intents while reserving cancellation capacity", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const waiting = deferred<Awaited<ReturnType<SQLiteStore["acceptCommand"]>>>();
  const accept = rpc.runtime.store.acceptCommand.getMockImplementation()!;
  rpc.runtime.store.acceptCommand.mockImplementation((command) =>
    command.method === "steer" ? waiting.promise : accept(command),
  );
  const ids = Array.from({ length: 9 }, () =>
    rpc.send("steer", "a", { text: "wait" }),
  );
  await setImmediate();
  try {
    expect(rpc.reply(ids[8]!)?.error).toMatch(/capacity/i);
    await rpc.request("cancel");
    expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
    expect(await rpc.request("hello", "b")).toMatchObject({
      protocolVersion: 2,
    });
  } finally {
    const first = rpc.runtime.store.acceptCommand.mock.calls.find(
      ([command]) => command.method === "steer",
    )![0];
    waiting.resolve(await accept(first));
    await setImmediate();
  }
});
