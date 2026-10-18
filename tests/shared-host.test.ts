import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { spawn as spawnPty, type IPty } from "node-pty";
import { stripVTControlCharacters } from "node:util";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientFiles } from "../packages/host/src/client-files.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { remoteConnection } from "../packages/remote/src/connection.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
const clock = {
  id: randomUUID,
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
async function directory() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-shared-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  return { home, cwd };
}
function encryptedDevice(
  bridge: SharedHostClient,
  deviceId: string,
  identity: ReturnType<typeof createIdentity>,
  device: ReturnType<typeof createIdentity>,
) {
  let active: any,
    drop = false,
    prompts = 0;
  let stop: () => void = () => {};
  const remote = remoteConnection(
    {
      v: 1,
      relay: "wss://fixture.example",
      hostId: randomToken(),
      deviceId,
      token: randomToken(),
      identity: device,
      hostKey: identity.publicKey,
      expires: Date.now() + 300000,
    },
    clock,
    {
      reconnectMs: 10,
      heartbeatMs: 60000,
      socket: () => {
        const channel = new SecureChannel("host", identity, device.publicKey);
        const socket: any = {
          readyState: 1,
          bufferedAmount: 0,
          send: (text: string) => {
            if (text === "ping") {
              queueMicrotask(() => socket.onmessage?.({ data: "pong" }));
              return;
            }
            const result = channel.receive(text);
            if (result.reply)
              queueMicrotask(() => socket.onmessage?.({ data: result.reply }));
            if (result.data) {
              const frame = result.data as any;
              if (frame.method === "prompt") prompts++;
              void dispatchRemote(bridge, deviceId, frame).then(
                (result) => {
                  if (
                    socket.readyState === 1 &&
                    !(drop && frame.method === "prompt")
                  )
                    socket.onmessage?.({
                      data: channel.send({
                        type: "response",
                        scope: deviceId,
                        id: frame.id,
                        result,
                      }),
                    });
                },
                (error) => {
                  if (socket.readyState === 1)
                    socket.onmessage?.({
                      data: channel.send({
                        type: "response",
                        scope: deviceId,
                        id: frame.id,
                        error: String(error),
                      }),
                    });
                },
              );
            }
          },
          close: (code: number) => {
            if (socket.readyState !== 1) return;
            socket.readyState = 3;
            stop();
            socket.onclose?.({ code });
          },
        };
        active = socket;
        stop = bridge.subscribe((frame) => {
          if (frame.scope === deviceId && socket.readyState === 1)
            socket.onmessage?.({ data: channel.send(frame) });
        });
        queueMicrotask(() => {
          socket.onopen?.();
          socket.onmessage?.({ data: channel.hello() });
        });
        return socket;
      },
    },
  );
  return {
    ...remote,
    disconnect: () => active.close(1006),
    drop: (value = true) => {
      drop = value;
    },
    prompts: () => prompts,
  };
}
async function toolProvider(home: string) {
  await writeFile(
    join(home, "fixture.mjs"),
    `export default {id:"shared-fixture",apiVersion:1,setup(host){
    host.registerProvider("fixture",async()=>({id:"fixture",model:"host",contextWindow:32000,
      async *stream({messages,signal}){signal.throwIfAborted();const last=messages.at(-1);
        const message=last.role==="user"?{role:"assistant",text:"",timestamp:1,toolCalls:[last.text==="delegate"?{id:"delegate",name:"subagent",arguments:{task:"nested-proof"}}:{id:last.text,name:"write_file",arguments:{path:last.text+".txt",content:"approved"}}]}:{role:"assistant",text:"finished once",timestamp:1};
        yield {type:"done",message,usage:{input:0,output:0,cost:0}};
      }
    }));
  }};`,
  );
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: [{ path: "fixture.mjs", trusted: true }] }),
  );
}
it("shares one run and explicitly owned approvals through local IPC and the encrypted device adapter", async () => {
  const options = await directory();
  const identity = createIdentity(),
    device = createIdentity(),
    deviceId = randomToken();
  const config = {
    relay: "wss://fixture.example",
    hostId: randomToken(),
    publicKey: identity.publicKey,
    devices: { [deviceId]: { publicKey: device.publicKey } },
  };
  await writeFile(join(options.home, "remote.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  await toolProvider(options.home);
  const host = await serveSharedHost({
    ...options,
    provider: "fixture",
    model: "host",
  });
  const wire = await SharedHostClient.connect({
    ...options,
    clientId: "owner",
  });
  const bridge = await SharedHostClient.connect({ ...options, mode: "bridge" });
  const local = new ClientConnection(wire.scope, wire, clock),
    remote = encryptedDevice(bridge, deviceId, identity, device);
  try {
    const rejectedSocket = createConnection(host.endpoint.socket);
    rejectedSocket.on("error", () => {});
    const rejectedClose = once(rejectedSocket, "close");
    rejectedSocket.write(
      JSON.stringify({
        type: "attach",
        mode: "local",
        clientId: "intruder",
        token: "x".repeat(43),
      }) + "\n",
    );
    await rejectedClose;
    await expect(serveSharedHost({ ...options, demo: true })).rejects.toThrow(
      /already owns/,
    );
    await local.connected();
    remote.connect();
    await vi.waitFor(() => expect(remote.client.state.canAct).toBe(true));
    expect(remote.client.state.hostInstanceId).toBe(local.state.hostInstanceId);
    const session = (await local.request("session.create")) as any;
    await expect(
      remote.client.request("session.resume", { sessionId: session.id }),
    ).rejects.toThrow(/denied/);
    expect(await remote.client.request("session.list")).toEqual([]);
    await local.request("session.access", { deviceId, role: "view" });
    await remote.client.request("session.resume", { sessionId: session.id });
    expect(
      await remote.client.request("plan.read", { sessionId: session.id }),
    ).toMatchObject({ active: false });
    expect(
      await remote.client.request("changes.list", { sessionId: session.id }),
    ).toMatchObject({ items: [] });
    expect(
      await remote.client.request("execution.read", {
        sessionId: session.id,
        kind: "queue",
      }),
    ).toEqual([]);
    for (const method of [
      "plan.set",
      "execution.hold",
      "execution.action",
      "changes.rollback",
      "questions.respond",
    ] as const) {
      await expect(
        remote.client.request(method, { sessionId: session.id, active: true }),
      ).rejects.toThrow(/denied/);
    }
    await expect(
      remote.client.request("prompt", { text: "unauthorized" }),
    ).rejects.toThrow(/denied/);
    await local.request("prompt", { text: "race" });
    await vi.waitFor(() => expect(local.state.approvals).toHaveLength(1));
    expect(remote.client.state.approvals).toHaveLength(0);
    const approval = local.state.approvals[0]!;
    await expect(
      remote.client.request("approval.respond", {
        id: approval.id,
        allow: true,
      }),
    ).rejects.toThrow(/denied/);
    await local.request("session.access", { deviceId, role: "control" });
    await vi.waitFor(() =>
      expect(remote.client.state.approvals[0]?.id).toBe(approval.id),
    );
    expect(remote.client.state.runId).toBe(local.state.runId);
    const race = await Promise.allSettled([
      local.request("approval.respond", { id: approval.id, allow: true }),
      remote.client.request("approval.respond", {
        id: approval.id,
        allow: true,
      }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
    await vi.waitFor(() => expect(local.state.runStatus).toBe("completed"));
    expect(await readFile(join(options.cwd, "race.txt"), "utf8")).toBe(
      "approved",
    );
    await local.request("prompt", { text: "delegate" });
    await vi.waitFor(() =>
      expect(remote.client.state.approvals).toHaveLength(1),
    );
    const delegated = remote.client.state.approvals[0]!;
    expect(delegated.sessionId).not.toBe(session.id);
    expect(delegated.authoritySessionId).toBe(session.id);
    await remote.client.request("approval.respond", {
      id: delegated.id,
      allow: true,
    });
    await vi.waitFor(() => expect(local.state.runStatus).toBe("completed"));
    expect(await readFile(join(options.cwd, "nested-proof.txt"), "utf8")).toBe(
      "approved",
    );
    await local.request("prompt", { text: "revoke-access" });
    await vi.waitFor(() =>
      expect(remote.client.state.approvals).toHaveLength(1),
    );
    const second = local.state.approvals[0]!;
    await local.request("session.access", { deviceId, role: null });
    await vi.waitFor(() => expect(remote.client.state.session).toBeNull());
    expect(local.state.approvals[0]?.id).toBe(second.id);
    await expect(
      remote.client.request("approval.respond", { id: second.id, allow: true }),
    ).rejects.toThrow(/denied/);
    await local.request("approval.respond", { id: second.id, allow: true });
    await vi.waitFor(() => expect(local.state.busy).toBe(false));
    await local.request("session.access", { deviceId, role: "control" });
    await remote.client.request("session.resume", { sessionId: session.id });
    remote.drop();
    const pending = remote.client.request("prompt", { text: "disconnected" });
    const rejected = expect(pending).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(local.state.approvals).toHaveLength(1));
    remote.disconnect();
    await rejected;
    expect(local.state.busy).toBe(true);
    await vi.waitFor(() =>
      expect(
        remote.client.state.canAct &&
          remote.client.state.approvals.length === 1,
      ).toBe(true),
    );
    await remote.client.request("approval.respond", {
      id: remote.client.state.approvals[0]!.id,
      allow: true,
    });
    await vi.waitFor(() => expect(local.state.runStatus).toBe("completed"));
    await remote.client.reconcile();
    expect(remote.prompts()).toBe(2); // one rejected attempt and one actual device-origin run
    expect(await readFile(join(options.cwd, "disconnected.txt"), "utf8")).toBe(
      "approved",
    );
    // A revoked device's queued prompt must not cancel the local owner's run.
    remote.drop(false);
    await local.request("prompt", { text: "owner-survives" });
    await vi.waitFor(() => expect(local.state.approvals).toHaveLength(1));
    const ownerApproval = local.state.approvals[0]!;
    await remote.client.request("prompt", { text: "queued-device" });
    await writeFile(
      join(options.home, "remote.json"),
      JSON.stringify({ ...config, devices: {} }),
    );
    await vi.waitFor(
      async () =>
        expect(
          ((await local.request("session.access.read")) as any[]).some(
            (a) => a.scope === deviceId,
          ),
        ).toBe(false),
      { timeout: 4000 },
    );
    expect(local.state.busy).toBe(true);
    expect(local.state.approvals[0]?.id).toBe(ownerApproval.id);
    await local.request("approval.respond", {
      id: ownerApproval.id,
      allow: true,
    });
    await vi.waitFor(() => expect(local.state.runStatus).toBe("completed"));
    await expect(
      access(join(options.cwd, "queued-device.txt")),
    ).rejects.toThrow();
    await writeFile(join(options.home, "remote.json"), JSON.stringify(config));
    await local.request("session.access", { deviceId, role: "control" });
    remote.disconnect();
    await vi.waitFor(() => expect(remote.client.state.canAct).toBe(true));
    await remote.client.request("session.resume", { sessionId: session.id });
    // Revoking pairing cancels only work started by this device, even offline.
    remote.drop(false);
    await remote.client.request("prompt", { text: "revoked-device" });
    await vi.waitFor(() => expect(local.state.approvals).toHaveLength(1));
    remote.disconnect();
    await writeFile(
      join(options.home, "remote.json"),
      JSON.stringify({ ...config, devices: {} }),
    );
    await vi.waitFor(() => expect(local.state.runStatus).toBe("cancelled"), {
      timeout: 4000,
    });
    await expect(
      access(join(options.cwd, "revoked-device.txt")),
    ).rejects.toThrow();
    expect(local.state.approvals).toHaveLength(0);
  } finally {
    remote.close();
    local.close();
    await wire.close();
    await bridge.close();
    await host.close();
    await rm(options.home, { recursive: true, force: true });
  }
}, 15000);

async function startHost(options: { home: string; cwd: string }) {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    resolve("apps/cli/src/index.ts"),
    "--host",
    "--demo",
    "--home",
    options.home,
    "--cwd",
    options.cwd,
  ]);
  let output = "";
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Host startup timed out: " + output));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-8192);
      if (output.includes("shared host ready:")) {
        clearTimeout(timer);
        done();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Host exited " + code + ": " + output));
    });
  });
  return child;
}
async function stop(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
it("recovers a recreated view's durable intent, then fences a crashed host without replay", async () => {
  const options = await directory();
  let host = await startHost(options);
  let wire = await SharedHostClient.connect({
    ...options,
    clientId: "recover",
  });
  const files = await ClientFiles.open(
    wire.endpoint.home,
    wire.endpoint.key,
    wire.scope,
  );
  let client = new ClientConnection(
    wire.scope,
    {
      observe: (fn) =>
        wire.observe((frame) => {
          if (frame.type !== "response" || frame.result?.accepted !== true)
            fn(frame);
        }),
      send: (frame) => wire.send(frame),
    },
    { ...clock, intents: files },
  );
  let off = wire.onConnection((ready) => {
    if (!ready) client.disconnected();
  });
  try {
    await client.connected();
    const session = (await client.request("session.create")) as any;
    const pending = client.request("prompt", {
      text: "survive-disconnect " + "x".repeat(700),
    });
    const rejected = expect(pending).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(client.state.busy).toBe(true));
    const run = client.state.runId;
    expect(JSON.stringify(await files.load())).not.toContain(
      "survive-disconnect",
    );
    off();
    client.disconnected();
    await wire.close();
    await rejected;
    client.close();
    wire = await SharedHostClient.connect({ ...options, clientId: "recover" });
    client = new ClientConnection(wire.scope, wire, {
      ...clock,
      intents: files,
    });
    off = wire.onConnection((ready) => {
      if (ready) void client.connected().catch(() => {});
      else client.disconnected();
    });
    await client.connected();
    expect(client.state.session?.id).toBe(session.id);
    expect(client.state.runId).toBe(run);
    await vi.waitFor(() => expect(client.state.runStatus).toBe("completed"), {
      timeout: 5000,
    });
    await client.reconcile();
    expect(client.receipts.find((r) => r.method === "prompt")?.status).toBe(
      "completed",
    );
    await client.request("prompt", { text: "crash " + "x".repeat(2000) });
    await vi.waitFor(() => expect(client.state.busy).toBe(true));
    const crashedRun = client.state.runId;
    await stop(host, "SIGKILL");
    await vi.waitFor(() => expect(client.state.connection).toBe("offline"));
    host = await startHost(options);
    await vi.waitFor(() => expect(client.state.canAct).toBe(true), {
      timeout: 8000,
    });
    expect(client.state).toMatchObject({
      session: { id: session.id },
      runId: crashedRun,
      runStatus: "unknown",
      busy: false,
      approvals: [],
    });
    const events = (await client.request("events.read", {
      limit: 1000,
    })) as any[];
    expect(events.filter((e) => e.type === "run.start")).toHaveLength(2);
    expect(
      client.receipts.filter((r) => r.method === "prompt").map((r) => r.status),
    ).toEqual(["completed", "unknown"]);
    // Insecure metadata fails closed without changing the running host.
    await chmod(wire.endpoint.metadata, 0o644);
    await expect(
      SharedHostClient.connect({ ...options, clientId: "unsafe" }),
    ).rejects.toThrow(/Unsafe/);
    await chmod(wire.endpoint.metadata, 0o600);
    // Reusing an identity fences its old view, rather than reconnecting forever.
    const replacement = await SharedHostClient.connect({
      ...options,
      clientId: "recover",
    });
    try {
      await vi.waitFor(() => expect(client.state.connection).toBe("offline"));
      await new Promise((done) => setTimeout(done, 300));
      expect((await replacement.request("session.current")).session.id).toBe(
        session.id,
      );
    } finally {
      await replacement.close();
    }
  } finally {
    off();
    client.close();
    await wire.close();
    await stop(host);
    await rm(options.home, { recursive: true, force: true });
  }
}, 20000);

it("attaches the real TUI, restores its draft and pending approval after exit, and accepts a second view's decision", async () => {
  const options = await directory();
  await toolProvider(options.home);
  const host = await serveSharedHost({
    ...options,
    provider: "fixture",
    model: "host",
  });
  const probe = await SharedHostClient.connect({
    ...options,
    clientId: "probe",
  });
  let terminal: IPty | undefined,
    exited: Promise<number> | undefined,
    output = "";
  const launch = () => {
    output = "";
    terminal = spawnPty(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("apps/cli/src/index.ts"),
        "--attach",
        "--home",
        options.home,
        "--cwd",
        options.cwd,
        "--client-id",
        "pty",
      ],
      { cols: 100, rows: 30, env: { ...process.env, TERM: "xterm-256color" } },
    );
    terminal.onData((chunk) => {
      output = (output + stripVTControlCharacters(chunk)).slice(-100000);
    });
    exited = new Promise((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
  };
  try {
    launch();
    await vi.waitFor(
      () => expect(output).toContain("Attached to shared host"),
      { timeout: 8000 },
    );
    const sessions = await probe.request("session.list");
    const session = sessions[0];
    await probe.request("session.resume", { sessionId: session.id });
    terminal!.write("pty-approval\r");
    await vi.waitFor(() => expect(output).toContain("Permission required"), {
      timeout: 8000,
    });
    // Quit while the panel is visible; detaching must not submit a denial.
    terminal!.write("\x04");
    expect(await exited).toBe(0);
    terminal = undefined;
    const pending = await probe.request("session.current");
    expect(pending.busy).toBe(true);
    expect(pending.approvals).toHaveLength(1);
    launch();
    await vi.waitFor(() => expect(output).toContain("Permission required"), {
      timeout: 8000,
    });
    await probe.request("approval.respond", {
      id: pending.approvals[0].id,
      allow: true,
    });
    await vi.waitFor(() => expect(output).toContain("finished once"), {
      timeout: 8000,
    });
    expect(await readFile(join(options.cwd, "pty-approval.txt"), "utf8")).toBe(
      "approved",
    );
    terminal!.write("unsent-恢复");
    await new Promise((done) => setTimeout(done, 400));
    terminal!.kill("SIGKILL");
    await exited;
    terminal = undefined;
    launch();
    await vi.waitFor(() => expect(output).toContain("unsent-恢复"), {
      timeout: 8000,
    });
    expect(
      (await probe.request("events.read")).filter(
        (event: any) => event.type === "run.start",
      ),
    ).toHaveLength(1);
    terminal!.write("\x15\x04");
    expect(await exited).toBe(0);
    terminal = undefined;
  } finally {
    if (terminal) {
      terminal.kill("SIGKILL");
      await exited;
    }
    await probe.close();
    await host.close();
    await rm(options.home, { recursive: true, force: true });
  }
}, 25000);

it("does not apply a waiting control to a newly selected view-only session", async () => {
  const { SQLiteStore } = await import("../packages/storage/src/index.ts");
  const options = await directory();
  await toolProvider(options.home);
  const deviceId = randomToken(),
    identity = createIdentity(),
    device = createIdentity();
  await writeFile(
    join(options.home, "remote.json"),
    JSON.stringify({
      relay: "wss://fixture.example",
      hostId: randomToken(),
      publicKey: identity.publicKey,
      devices: { [deviceId]: { publicKey: device.publicKey } },
    }),
  );
  const host = await serveSharedHost({
    ...options,
    provider: "fixture",
    model: "host",
  });
  const owner = await SharedHostClient.connect({
      ...options,
      clientId: "owner",
    }),
    bridge = await SharedHostClient.connect({ ...options, mode: "bridge" });
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((done) => {
      entered = done;
    }),
    gate = new Promise<void>((done) => {
      release = done;
    });
  const accept = SQLiteStore.prototype.acceptCommand;
  const spy = vi
    .spyOn(SQLiteStore.prototype, "acceptCommand")
    .mockImplementation(async function (
      this: import("../packages/storage/src/index.ts").SQLiteStore,
      command,
    ) {
      if (command.method === "cancel" && command.scope === deviceId) {
        entered();
        await gate;
      }
      return accept.call(this, command);
    });
  try {
    const controllable = await owner.request("session.create");
    await owner.request("session.access", { deviceId, role: "control" });
    const protectedSession = await owner.request("session.create");
    await owner.request("session.access", { deviceId, role: "view" });
    await owner.request("prompt", { text: "protected" });
    let pending: any;
    await vi.waitFor(async () => {
      pending = await owner.request("session.current");
      expect(pending.approvals).toHaveLength(1);
    });
    await bridge.request(
      "session.resume",
      { sessionId: controllable.id },
      false,
      { scope: deviceId },
    );
    const cancel = bridge.request("cancel", {}, false, { scope: deviceId });
    const rejected = expect(cancel).rejects.toThrow(/selection changed/i);
    await waiting;
    await bridge.request(
      "session.resume",
      { sessionId: protectedSession.id },
      false,
      { scope: deviceId },
    );
    release();
    await rejected;
    expect(await owner.request("session.current")).toMatchObject({
      busy: true,
      approvals: [{ id: pending.approvals[0].id }],
    });
    await owner.request("approval.respond", {
      id: pending.approvals[0].id,
      allow: true,
    });
    await vi.waitFor(async () =>
      expect((await owner.request("session.current")).runStatus).toBe(
        "completed",
      ),
    );
  } finally {
    release();
    spy.mockRestore();
    await bridge.close();
    await owner.close();
    await host.close();
    await rm(options.home, { recursive: true, force: true });
  }
}, 10000);
