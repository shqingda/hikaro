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
  runId: null,
  runStatus: "idle" as const,
  approvals: [],
});
function response(
  client: ClientState,
  epoch: number,
  id: string,
  result: unknown,
) {
  client.receive(epoch, { type: "response", scope: "local", id, result });
}
function ready() {
  const client = new ClientState("local");
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
  scope = "local",
) {
  return {
    type: "event",
    scope,
    revision: seq,
    event: { sessionId, seq, type, data, timestamp: 1 },
  };
}
it("reads isolated control status without copying stream or event history", () => {
  const { client, epoch } = ready();
  client.receive(epoch, event(1, "text.delta", { text: "中".repeat(100000) }));
  client.receive(epoch, {
    type: "approval",
    scope: "local",
    revision: 2,
    request: {
      id: "approval-1",
      sessionId: "s1",
      tool: "shell",
      reason: "execution",
      arguments: { command: "test" },
    },
  });
  const status = client.status;
  expect(status).toMatchObject({
    canAct: true,
    cursor: 1,
    session,
    approvals: [{ id: "approval-1" }],
  });
  expect(status).not.toHaveProperty("stream");
  expect(status).not.toHaveProperty("events");
  status.session!.title = "consumer change";
  status.approvals[0]!.arguments.command = "consumer change";
  expect(client.status.session?.title).toBe("Fixture");
  expect(client.status.approvals[0]!.arguments.command).toBe("test");
  expect(client.state.stream).toHaveLength(100000);
  client.disconnected(epoch);
  expect(client.status).toMatchObject({ connection: "offline", canAct: false });
});
it("retains a metadata invalidation arriving after a snapshot watermark but before its response", () => {
  const { client, epoch } = ready();
  client.command("racing-snapshot", "session.current");
  client.receive(epoch, {
    type: "session.invalidated",
    scope: "local",
    revision: 1,
  });
  response(client, epoch, "racing-snapshot", snapshot(0));
  expect(client.state).toMatchObject({
    revision: 1,
    syncRequired: true,
    canAct: false,
  });
  client.command("fresh-metadata", "session.current");
  response(client, epoch, "fresh-metadata", {
    ...snapshot(0),
    revision: 1,
    session: { ...session, title: "Renamed" },
  });
  expect(client.state).toMatchObject({
    session: { title: "Renamed" },
    canAct: true,
  });
});
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
    scope: "local",
    revision: 1,
    request: approval,
  });
  // This earlier notification must not resurrect a request absent at the barrier.
  response(client, epoch, "current", { ...snapshot(), revision: 2 });
  expect(client.state.approvals).toEqual([]);
  client.receive(epoch, {
    type: "approval",
    scope: "local",
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
    scope: "local",
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
  ).toMatchObject({ id: "intent-1", scope: "local", method: "prompt" });
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
  for (let n = 0; n < 60; n++) {
    client.command(`read-${n}`, "prompt", { text: "task" });
    response(client, epoch, `read-${n}`, { accepted: true });
  }
  expect(client.receipts).toHaveLength(62);
  expect(() => client.command("overflow", "prompt", { text: "x" })).toThrow(
    /capacity/i,
  );
  for (let index = 0; index < 5; index++) {
    client.command(`query-${index}`, "command.receipt", {
      commandId: "read-0",
    });
    response(client, epoch, `query-${index}`, { receipt: null });
  }
  expect(client.receipts).toHaveLength(64);
  expect(client.receipt("read-0")?.status).toBe("acknowledged");
});
it("rejects malformed/oversized trusted-scope frames and incompatible handshake state", () => {
  const { client, epoch } = ready();
  expect(() => client.receive(epoch, event(-1))).toThrow(/invalid/i);
  expect(client.state.canAct).toBe(false);
  const other = new ClientState("local");
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
    scope: "local",
    revision: 1,
    request,
  });
  client.receive(epoch, {
    type: "approval.resolved",
    scope: "local",
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
  const client = new ClientState("local");
  const epoch = client.beginConnection();
  client.command("hello", "hello");
  response(client, epoch, "hello", {
    ...rpcCapabilities(),
    methods: [...rpcCapabilities().methods, "future.additive.method"],
  });
  expect(() => client.command("snapshot", "session.current")).not.toThrow();
});

it("restores authoritative run identity without inferring outcomes for legacy snapshots", () => {
  const { client, epoch } = ready();
  client.command("active", "session.current");
  response(client, epoch, "active", {
    ...snapshot(4),
    busy: true,
    runId: "active-run",
    runStatus: "running",
    stream: "in progress",
  });
  expect(client.state).toMatchObject({
    runId: "active-run",
    runStatus: "running",
  });
  client.command("settled", "session.current");
  response(client, epoch, "settled", {
    ...snapshot(8),
    runId: "active-run",
    runStatus: "completed",
  });
  expect(client.state).toMatchObject({
    runId: "active-run",
    runStatus: "completed",
    busy: false,
  });
  client.command("legacy", "session.current");
  const { runId, runStatus, ...legacy } = snapshot(10);
  response(client, epoch, "legacy", { ...legacy, busy: true });
  expect(client.state).toMatchObject({ runId: null, runStatus: "unknown" });
});

it("fences negotiated host identities and accepts a new host only after a new connection handshake", () => {
  const client = new ClientState("local");
  const epoch = client.beginConnection();
  client.command("hello-a", "hello");
  client.receive(epoch, {
    type: "response",
    scope: "local",
    id: "hello-a",
    hostInstanceId: "host-a",
    result: { ...rpcCapabilities(), hostInstanceId: "host-a" },
  });
  client.command("snapshot-a", "session.current");
  client.receive(epoch, {
    type: "response",
    scope: "local",
    id: "snapshot-a",
    hostInstanceId: "host-a",
    result: { ...snapshot(), hostInstanceId: "host-a" },
  });
  expect(client.state).toMatchObject({
    hostInstanceId: "host-a",
    canAct: true,
  });
  expect(() =>
    client.receive(epoch, { ...event(1), hostInstanceId: "host-b" }),
  ).toThrow(/host/i);
  expect(client.state).toMatchObject({
    hostInstanceId: "host-a",
    canAct: false,
    stream: "",
  });
  const next = client.beginConnection();
  client.command("hello-b", "hello");
  client.receive(next, {
    type: "response",
    scope: "local",
    id: "hello-b",
    hostInstanceId: "host-b",
    result: { ...rpcCapabilities(), hostInstanceId: "host-b" },
  });
  client.command("snapshot-b", "session.current");
  client.receive(next, {
    type: "response",
    scope: "local",
    id: "snapshot-b",
    hostInstanceId: "host-b",
    result: { ...snapshot(), hostInstanceId: "host-b" },
  });
  client.receive(epoch, { ...event(1), hostInstanceId: "host-a" });
  client.receive(next, { ...event(1), hostInstanceId: "host-b" });
  expect(client.state).toMatchObject({
    hostInstanceId: "host-b",
    canAct: true,
    stream: "x",
  });
  // Remote wrappers may omit the envelope identity; the negotiated snapshot
  // still has to belong to this host.
  client.receive(next, event(2));
  client.command("mismatched-snapshot", "session.current");
  expect(() =>
    client.receive(next, {
      type: "response",
      scope: "local",
      id: "mismatched-snapshot",
      hostInstanceId: "host-b",
      result: { ...snapshot(2), hostInstanceId: "host-a" },
    }),
  ).toThrow(/invalid/i);
  expect(client.state.canAct).toBe(false);
});

it("reconciles durable receipts while unsynchronized without replaying uncertain mutations", () => {
  const { client, epoch } = ready();
  for (let index = 0; index < 60; index++) {
    client.command(`intent-${index}`, "prompt", { text: "task" });
    client.timedOut(`intent-${index}`);
  }
  const next = client.beginConnection();
  client.command("hello-again", "hello");
  response(client, next, "hello-again", rpcCapabilities());
  client.command("missing", "command.receipt", { commandId: "intent-0" });
  response(client, next, "missing", { receipt: null });
  expect(client.receipt("intent-0")?.status).toBe("unknown");
  const durable = {
    id: "intent-0",
    scope: "local",
    method: "prompt",
    digest: "a".repeat(64),
    hostInstanceId: "host-original",
    sessionId: "s1",
    runId: "recovered-run",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
  };
  client.command("accepted", "command.receipt", { commandId: "intent-0" });
  response(client, next, "accepted", {
    receipt: { ...durable, status: "accepted" },
  });
  expect(client.receipt("intent-0")).toMatchObject({
    status: "acknowledged",
    durableStatus: "accepted",
  });
  client.command("lookup", "command.receipt", { commandId: "intent-0" });
  response(client, next, "lookup", { receipt: durable });
  expect(client.receipt("intent-0")).toMatchObject({
    status: "completed",
    durableStatus: "completed",
    runId: "recovered-run",
  });
  client.command("unrelated", "command.receipt", { commandId: "intent-1" });
  expect(() =>
    response(client, next, "unrelated", { receipt: durable }),
  ).toThrow(/invalid/i);
  expect(client.receipt("intent-1")?.status).toBe("unknown");
  expect(() => client.command("intent-1", "prompt", { text: "again" })).toThrow(
    /already/i,
  );
  response(client, epoch, "intent-1", { accepted: true });
  expect(client.receipt("intent-1")?.status).toBe("unknown");
});
