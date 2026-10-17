import { afterEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { Runtime, type RuntimeOptions } from "../packages/runtime/src/index.ts";
import { serveRpc } from "../apps/cli/src/rpc.ts";
import type { Session } from "../packages/core/src/index.ts";
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
      snapshot: () => { busy: boolean };
      subscribe: () => () => void;
    }
  >();
  const compact = deferred<Session>();
  const run = deferred();
  const runtime = {
    options: { cwd: "/workspace" },
    store: {
      sessions: vi.fn(async () => [...sessions.values()]),
      claim: vi.fn(async () => true),
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
          snapshot: () => ({ busy: false }),
          subscribe: () => () => {},
        };
        agents.set(session.id, agent);
      }
      return agent;
    },
    compact: vi.fn(() => compact.promise),
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

it("delivers compaction completion through scoped operation events", async () => {
  const rpc = await connection();
  const session = await rpc.request("session.create");
  const accepted = await rpc.request("session.compact");
  const continuation = { ...session, id: "continuation" };
  rpc.compact.resolve(continuation);
  await setImmediate();
  expect(rpc.messages).toContainEqual({
    type: "operation.completed",
    scope: "a",
    operationId: accepted.operationId,
    method: "session.compact",
    result: continuation,
  });
  expect((await rpc.request("session.current")).session.id).toBe(
    "continuation",
  );
});

it("reports failed compaction without failing later requests", async () => {
  const rpc = await connection();
  await rpc.request("session.create");
  const accepted = await rpc.request("session.compact");
  rpc.compact.reject(Error("Summary unavailable"));
  await setImmediate();
  expect(rpc.messages).toContainEqual({
    type: "operation.failed",
    scope: "a",
    operationId: accepted.operationId,
    method: "session.compact",
    error: "Summary unavailable",
  });
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
  const claim = deferred<boolean>();
  rpc.runtime.store.claim.mockImplementation(() => claim.promise);
  const prompt = rpc.send("prompt", "a", { text: "first" });
  await setImmediate();
  await rpc.request("cancel");
  claim.resolve(true);
  await setImmediate();
  expect(rpc.reply(prompt)?.error).toMatch(/cancelled/i);
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
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
  await rpc.request("approval.respond", "a", { id: "after-detach", allow: false });
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
  await rpc.request("session.create");
  first.resolve();
  await setImmediate();
  await rpc.request("client.detach", "a", { cancel: true });
  expect(rpc.agents.get(session.id)?.cancelled).toBe(true);
  second.resolve();
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
