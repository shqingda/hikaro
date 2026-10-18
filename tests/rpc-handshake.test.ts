import { afterEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveRpc } from "../apps/cli/src/rpc.ts";
import { ClientState } from "../packages/client-core/src/index.ts";
import { ProcessClient } from "../packages/protocol/src/client.ts";
import { JsonLines } from "../packages/protocol/src/index.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function rpc() {
  const cwd = await mkdtemp(join(tmpdir(), "hikaro-handshake-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<string, (value: any) => void>();
  const frames: any[] = [];
  const observers = new Set<(frame: unknown) => void>();
  const parser = new JsonLines((frame: any) => {
    frames.push(frame);
    for (const observer of observers) observer(frame);
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });
  output.on("data", (chunk) => parser.push(chunk));
  const server = await serveRpc(
    { cwd, home: join(cwd, "home"), demo: true },
    { input, output, error: new PassThrough() },
  );
  cleanup.push(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  let sequence = 0;
  function send(frame: { id: string; [key: string]: unknown }) {
    const response = new Promise<any>((resolve) =>
      pending.set(frame.id, resolve),
    );
    input.write(JSON.stringify(frame) + "\n");
    return response;
  }
  function request(
    method: string,
    params: Record<string, unknown> = {},
    scope = "desktop",
  ) {
    const id = `request-${sequence++}`;
    const response = new Promise<any>((resolve) => pending.set(id, resolve));
    input.write(JSON.stringify({ id, scope, method, params }) + "\n");
    return response;
  }
  return {
    request,
    frames,
    send,
    observe: (fn: (frame: unknown) => void) => observers.add(fn),
  };
}
it("negotiates actual protocol capabilities without creating a session", async () => {
  const client = await rpc();
  const hello = await client.request("hello", { protocolVersions: [2] });
  expect(hello.error).toBeUndefined();
  expect(hello.result).toMatchObject({
    protocolVersion: 2,
    snapshotMethod: "session.current",
    eventSequence: "global-monotonic-filtered-by-session",
    commandReplay: "never-automatic",
    runIdentity: "events-only",
    runSnapshotIdentity: true,
  });
  expect(hello.result.methods).toContain("prompt");
  expect(hello.result.methods).toContain("hello");
  expect((await client.request("session.current")).result).toMatchObject({
    session: null,
    busy: false,
    cursor: 0,
    approvals: [],
  });
  expect(
    (await client.request("hello", { protocolVersions: [99] })).error,
  ).toMatch(/version/i);
  expect(
    (await client.request("hello", { protocolVersions: [] })).error,
  ).toBeTruthy();
  const created = await client.request("session.create");
  expect(created.result.id).toBeTruthy();
  expect(
    (await client.request("session.current", {}, "mobile")).result.session,
  ).toBeNull();
}, 10000);

it("drives the portable state through the real RPC handler and SQLite without a provider network", async () => {
  const rpcHost = await rpc();
  const state = new ClientState("desktop");
  const epoch = state.beginConnection();
  rpcHost.observe((frame) => state.receive(epoch, frame));
  await rpcHost.send(state.command("hello", "hello"));
  await rpcHost.send(state.command("initial", "session.current"));
  await rpcHost.send(state.command("create", "session.create"));
  await rpcHost.send(state.command("selected", "session.current"));
  expect(state.state.session?.id).toBeTruthy();
  await rpcHost.request("session.create", {}, "mobile");
  await rpcHost.request(
    "prompt",
    { text: "consume global event sequence" },
    "mobile",
  );
  await vi.waitFor(
    () =>
      expect(
        rpcHost.frames.some(
          (frame) =>
            frame.type === "event" &&
            frame.scope === "mobile" &&
            frame.event.type === "run.end",
        ),
      ).toBe(true),
    { timeout: 5000 },
  );
  await rpcHost.send(state.command("intent", "prompt", { text: "hello" }));
  await vi.waitFor(() => expect(state.state.runStatus).toBe("completed"), {
    timeout: 5000,
  });
  expect(state.receipt("intent")?.status).toBe("acknowledged");
  expect(state.state.cursor).toBeGreaterThan(0);
  const before = state.state;
  state.disconnected(epoch);
  const next = state.beginConnection();
  // Replace the observer's epoch for this same live host, simulating a transport reconnect.
  rpcHost.observe((frame) => state.receive(next, frame));
  await rpcHost.send(state.command("hello-again", "hello"));
  await rpcHost.send(state.command("restored", "session.current"));
  expect(state.state).toMatchObject({
    session: { ...before.session, title: "hello" },
    cursor: before.cursor,
    revision: before.revision,
    busy: false,
    canAct: true,
    runId: before.runId,
    runStatus: before.runStatus,
  });
}, 10000);
it("restores a root session read from SQLite through resume and snapshot", async () => {
  const host = await rpc();
  const created = await host.request("session.create");
  const state = new ClientState("mobile");
  const epoch = state.beginConnection();
  host.observe((frame) => state.receive(epoch, frame));
  await host.send(state.command("hello-resume", "hello"));
  await host.send(state.command("empty", "session.current"));
  const resumed = await host.send(
    state.command("resume", "session.resume", { sessionId: created.result.id }),
  );
  expect(resumed.error).toBeUndefined();
  expect(resumed.result.parentId).toBeNull();
  expect(state.state.canAct).toBe(false);
  await host.send(state.command("snapshot", "session.current"));
  expect(state.state).toMatchObject({
    session: { id: created.result.id, parentId: null },
    canAct: true,
    syncRequired: false,
  });
});
it("observes raw responses in order without changing ProcessClient request routing", async () => {
  const client = new ProcessClient(process.execPath, [
    "-e",
    `process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{for(const line of data.trim().split('\\n')){const q=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:q.id,result:{ok:true}})+'\\n'+JSON.stringify({type:'event',scope:'desktop',event:{seq:1}})+'\\n')}})`,
  ]);
  cleanup.push(() => client.close());
  const frames: unknown[] = [];
  client.observe((frame) => frames.push(frame));
  client.observe(() => {
    throw Error("observer failure");
  });
  expect(await client.request("hello")).toEqual({ ok: true });
  await vi.waitFor(() => expect(frames).toHaveLength(2));
  expect(frames).toMatchObject([{ type: "response" }, { type: "event" }]);
});
it("rejects malformed image bytes inside the existing RPC frame budget", async () => {
  const host = await rpc();
  await host.request("session.create");
  const reply = await host.request("prompt", {
    text: "describe",
    images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
  });
  expect(reply.error).toMatch(/image|format|header|signature/i);
  expect(
    host.frames.some(
      (frame) => frame.type === "event" && frame.event.type === "run.start",
    ),
  ).toBe(false);
});
