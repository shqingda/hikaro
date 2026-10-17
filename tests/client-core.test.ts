import { expect, it } from "vitest";
import { ClientState } from "../packages/client-core/src/index.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";
const session = { id: "s1", title: "Fixture", cwd: "/workspace", createdAt: 1 };
const snapshot = (cursor = 0) => ({
  session,
  cursor,
  revision: cursor,
  busy: false,
  stream: "",
  streamTruncated: false,
  approvals: [],
});
function response(
  client: ClientState,
  epoch: number,
  id: string,
  result: unknown,
) {
  client.receive(epoch, { type: "response", scope: "desktop", id, result });
}
function ready() {
  const client = new ClientState("desktop");
  const epoch = client.beginConnection();
  client.command("hello", "hello", { protocolVersions: [2] });
  response(client, epoch, "hello", rpcCapabilities());
  client.command("snapshot", "session.current");
  response(client, epoch, "snapshot", snapshot());
  return { client, epoch };
}
function event(
  seq: number,
  type = "text.delta",
  data: Record<string, unknown> = { text: "x" },
  sessionId = "s1",
  scope = "desktop",
) {
  return {
    type: "event",
    scope,
    revision: seq,
    event: { sessionId, seq, type, data, timestamp: 1 },
  };
}
it("deduplicates only the selected scope/session and freezes mutations on a sequence gap", () => {
  const { client, epoch } = ready();
  client.receive(epoch, event(1, "run.start", { runId: "run-1" }));
  client.receive(epoch, event(2, "text.delta", { text: "hello" }));
  client.receive(epoch, event(2, "text.delta", { text: "duplicate" }));
  client.receive(epoch, event(3, "text.delta", { text: "foreign" }, "s2"));
  client.receive(
    epoch,
    event(3, "text.delta", { text: "foreign" }, "s1", "phone"),
  );
  expect(client.state).toMatchObject({
    cursor: 2,
    stream: "hello",
    runId: "run-1",
    busy: true,
    canAct: true,
  });
  client.receive(epoch, event(5));
  expect(client.state).toMatchObject({
    cursor: 2,
    syncRequired: true,
    canAct: false,
  });
  expect(() => client.command("unsafe", "prompt", { text: "go" })).toThrow(
    /snapshot/i,
  );
  client.command("repair", "session.current");
  response(client, epoch, "repair", {
    ...snapshot(5),
    stream: "restored",
    busy: true,
  });
  client.receive(epoch, event(6, "text.delta", { text: "!" }));
  expect(client.state).toMatchObject({
    cursor: 6,
    stream: "restored!",
    runId: null,
    canAct: true,
  });
});
it("restores approvals at the snapshot barrier and removes resolved requests", () => {
  const { client, epoch } = ready();
  const approval = {
    id: "approval-1",
    sessionId: "s1",
    tool: "shell",
    reason: "execution",
    arguments: { command: "test" },
  };
  client.command("current", "session.current");
  client.receive(epoch, {
    type: "approval",
    scope: "desktop",
    revision: 1,
    request: approval,
  });
  // This earlier notification must not resurrect a request absent at the barrier.
  response(client, epoch, "current", { ...snapshot(), revision: 2 });
  expect(client.state.approvals).toEqual([]);
  client.receive(epoch, {
    type: "approval",
    scope: "desktop",
    revision: 3,
    request: approval,
  });
  expect(client.state.approvals).toHaveLength(1);
  client.receive(epoch, {
    type: "approval.resolved",
    scope: "phone",
    revision: 4,
    id: "approval-1",
    allow: true,
  });
  expect(client.state.approvals).toHaveLength(1);
  client.receive(epoch, {
    type: "approval.resolved",
    scope: "desktop",
    revision: 4,
    id: "approval-1",
    allow: false,
  });
  expect(client.state.approvals).toEqual([]);
});
it("does not reinterpret connection loss as failure or resend unknown commands after reconnect", () => {
  const { client, epoch } = ready();
  expect(
    client.command("intent-1", "prompt", { text: "change it" }),
  ).toMatchObject({ id: "intent-1", scope: "desktop", method: "prompt" });
  client.disconnected(epoch);
  expect(client.receipt("intent-1")?.status).toBe("unknown");
  expect(client.state.canAct).toBe(false);
  expect(() => client.command("intent-2", "prompt", { text: "again" })).toThrow(
    /connect/i,
  );
  const next = client.beginConnection();
  response(client, epoch, "intent-1", { accepted: true });
  client.command("hello-2", "hello");
  response(client, next, "hello-2", rpcCapabilities());
  client.command("snapshot-2", "session.current");
  response(client, next, "snapshot-2", snapshot(9));
  expect(client.receipt("intent-1")?.status).toBe("unknown");
  expect(() =>
    client.command("intent-1", "prompt", { text: "different" }),
  ).toThrow(/already/i);
  expect(client.state.canAct).toBe(true);
});
it("distinguishes accepted commands from completed runs and handles timeout without transport access", () => {
  const { client, epoch } = ready();
  client.command("prompt", "prompt", { text: "task" });
  response(client, epoch, "prompt", { accepted: true });
  expect(client.receipt("prompt")?.status).toBe("acknowledged");
  client.receive(epoch, event(1, "run.start", { runId: "run" }));
  client.receive(
    epoch,
    event(2, "run.end", { runId: "run", status: "completed" }),
  );
  expect(client.state).toMatchObject({ busy: false, runStatus: "completed" });
  client.command("uncertain", "approval.respond", {
    id: "request",
    allow: true,
  });
  client.timedOut("uncertain");
  expect(client.receipt("uncertain")?.status).toBe("unknown");
});
it("bounds history/stream/receipts and preserves uncertainty under pressure", () => {
  const { client, epoch } = ready();
  for (let n = 1; n <= 100; n++)
    client.receive(epoch, event(n, "text.delta", { text: "x".repeat(1500) }));
  expect(client.state.events).toHaveLength(64);
  expect(client.state.stream).toHaveLength(100000);
  expect(client.state.streamTruncated).toBe(true);
  for (let n = 0; n < 64; n++) {
    client.command(`read-${n}`, "prompt", { text: "task" });
    client.timedOut(`read-${n}`);
  }
  expect(client.receipts).toHaveLength(64);
  expect(() => client.command("overflow", "prompt", { text: "x" })).toThrow(
    /capacity/i,
  );
  expect(client.receipt("read-0")?.status).toBe("unknown");
});
it("rejects malformed/oversized trusted-scope frames and incompatible handshake state", () => {
  const { client, epoch } = ready();
  expect(() => client.receive(epoch, event(-1))).toThrow(/invalid/i);
  expect(client.state.canAct).toBe(false);
  const other = new ClientState("desktop");
  const e = other.beginConnection();
  other.command("h", "hello");
  expect(() =>
    response(other, e, "h", { ...rpcCapabilities(), protocolVersion: 99 }),
  ).toThrow(/invalid/i);
  expect(other.state.canAct).toBe(false);
  const fresh = ready();
  expect(() =>
    fresh.client.receive(
      fresh.epoch,
      event(1, "text.delta", { text: "x".repeat(1_048_577) }),
    ),
  ).toThrow(/capacity/i);
});
it("requires a new snapshot after session-changing replies and cannot expose mutable internal state", () => {
  const { client, epoch } = ready();
  client.command("select", "session.resume", { sessionId: "s2" });
  response(client, epoch, "select", { ...session, id: "s2" });
  expect(client.state.canAct).toBe(false);
  client.command("current", "session.current");
  response(client, epoch, "current", {
    ...snapshot(),
    session: { ...session, id: "s2" },
  });
  const copy = client.state;
  copy.session!.title = "mutated";
  copy.events.push({ seq: 99, type: "fake", timestamp: 1 });
  expect(client.state.session?.title).toBe("Fixture");
  expect(client.state.events).toEqual([]);
});

it("merges notifications newer than a delayed remote snapshot without resurrecting older approvals", () => {
  const { client, epoch } = ready();
  client.command("remote-snapshot", "session.current");
  const request = {
    id: "approval",
    sessionId: "s1",
    tool: "shell",
    reason: "check",
    arguments: {},
  };
  client.receive(epoch, {
    type: "approval",
    scope: "desktop",
    revision: 1,
    request,
  });
  client.receive(epoch, {
    type: "approval.resolved",
    scope: "desktop",
    revision: 2,
    id: "approval",
    allow: false,
  });
  client.receive(epoch, {
    ...event(1, "text.delta", { text: "after snapshot" }),
    revision: 3,
  });
  response(client, epoch, "remote-snapshot", {
    ...snapshot(),
    revision: 1,
    approvals: [request],
  });
  expect(client.state).toMatchObject({
    revision: 3,
    cursor: 1,
    stream: "after snapshot",
    approvals: [],
    canAct: true,
  });
});
it("requires a second snapshot when the bounded reconnect buffer overflows", () => {
  const { client, epoch } = ready();
  client.command("snapshot-overflow", "session.current");
  for (let i = 1; i <= 129; i++) client.receive(epoch, event(i));
  response(client, epoch, "snapshot-overflow", snapshot(120));
  expect(client.state.canAct).toBe(false);
  client.command("snapshot-after-overflow", "session.current");
  response(client, epoch, "snapshot-after-overflow", snapshot(129));
  expect(client.state.canAct).toBe(true);
});

it("accepts filtered global event sequence jumps when scope revisions are contiguous", () => {
  const { client, epoch } = ready();
  client.receive(epoch, event(1, "run.start", { runId: "run" }));
  client.receive(epoch, {
    ...event(3, "text.delta", { text: "second session consumed seq 2" }),
    revision: 2,
  });
  expect(client.state).toMatchObject({
    cursor: 3,
    revision: 2,
    canAct: true,
    stream: "second session consumed seq 2",
  });
});
it("negotiates known methods when a compatible host advertises future additions", () => {
  const client = new ClientState("desktop");
  const epoch = client.beginConnection();
  client.command("hello", "hello");
  response(client, epoch, "hello", {
    ...rpcCapabilities(),
    methods: [...rpcCapabilities().methods, "future.additive.method"],
  });
  expect(() => client.command("snapshot", "session.current")).not.toThrow();
});
