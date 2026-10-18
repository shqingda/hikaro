import { it, expect, vi } from "vitest";
import { MobileController } from "../apps/mobile/src/controller.ts";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";
const clock = {
  id: randomToken,
  schedule: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
function fixture(hooks?: {
  request(frame: any): Promise<unknown>;
  subscribe(fn: (frame: any) => void): () => void;
}) {
  const host = createIdentity(),
    device = createIdentity();
  const pairing = {
    v: 1 as const,
    relay: "wss://fixture.example",
    hostId: randomToken(),
    deviceId: randomToken(),
    token: randomToken(),
    identity: device,
    hostKey: host.publicKey,
    expires: Date.now() + 300000,
  };
  let credential: string | null = null,
    active: any,
    dropResume = false;
  const intents: any[] = [];
  const sent: any[] = [];
  const session = {
    id: "s1",
    title: "共享任务",
    cwd: "/workspace",
    createdAt: 1,
  };
  let selected: any = session,
    revision = 0;
  const store = {
    read: vi.fn(async () => credential),
    write: vi.fn(async (value: string) => {
      credential = value;
    }),
    erase: vi.fn(async () => {
      credential = null;
    }),
    journal: () => ({
      load: async () => intents.slice(),
      save: async (value: any[]) => {
        intents.splice(0, intents.length, ...value);
      },
    }),
    clear: vi.fn(async () => {
      intents.length = 0;
    }),
  };
  const socket = () => {
    const channel = new SecureChannel("host", host, device.publicKey);
    let release = () => {};
    const ws: any = {
      readyState: 1,
      bufferedAmount: 0,
      send(text: string) {
        if (text === "ping") return;
        const result = channel.receive(text);
        if (result.reply)
          queueMicrotask(() => ws.onmessage?.({ data: result.reply }));
        if (result.data) {
          const frame = result.data as any;
          sent.push(frame);
          const rpcResult = hooks
            ? hooks.request(frame)
            : frame.method === "hello"
              ? rpcCapabilities(true)
              : frame.method === "session.current"
                ? {
                    session: selected,
                    sessionRole: "view",
                    busy: false,
                    stream: "",
                    streamTruncated: false,
                    cursor: 2,
                    revision,
                    runId: "run1",
                    runStatus: "completed",
                    approvals: [],
                  }
                : frame.method === "session.list"
                  ? [session]
                  : frame.method === "messages.read"
                    ? {
                        items: [
                          {
                            seq: 2,
                            message: {
                              role: "assistant",
                              text: "已恢复的结果",
                              timestamp: 1,
                            },
                          },
                        ],
                        hasOlder: false,
                        hasNewer: false,
                      }
                    : frame.method === "session.resume"
                      ? (selected = session)
                      : { receipt: null };
          void Promise.resolve(rpcResult).then(
            (result) => {
              if (dropResume && frame.method === "session.resume") {
                dropResume = false;
                ws.close(1006);
                return;
              }
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    result,
                  }),
                });
            },
            (error) => {
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    error: String(error),
                  }),
                });
            },
          );
        }
      },
      close(code: number) {
        if (ws.readyState !== 1) return;
        ws.readyState = 3;
        release();
        ws.onclose?.({ code });
      },
    };
    if (hooks)
      release = hooks.subscribe((frame) => {
        if (frame.scope === pairing.deviceId && ws.readyState === 1)
          ws.onmessage?.({ data: channel.send(frame) });
      });
    active = ws;
    queueMicrotask(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: channel.hello() });
    });
    return ws;
  };
  return {
    pairing,
    host,
    store,
    sent,
    options: {
      ...clock,
      probe: async () => "ready" as const,
      socketOptions: { socket, reconnectMs: 1, heartbeatMs: 60000 },
    },
    uri: () => "hikaro://pair#" + encodeURIComponent(JSON.stringify(pairing)),
    dropResume: () => {
      dropResume = true;
    },
    close: (code: number) => active.close(code),
    get credential() {
      return credential;
    },
  };
}
it("requires review, persists credentials, restores a bounded read-only view and locks revoked devices", async () => {
  const f = fixture();
  const app = new MobileController(f.store, f.options);
  try {
    expect(() => app.review("hikaro://pair#bad")).toThrow();
    expect(f.store.write).not.toHaveBeenCalled();
    app.review(f.uri());
    expect(app.state.phase).toBe("review");
    expect(f.sent).toEqual([]);
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() =>
      expect(app.state.messages[0]?.message.text).toBe("已恢复的结果"),
    );
    expect(f.credential).not.toBeNull();
    expect(JSON.stringify(app.state)).not.toContain(f.pairing.token);
    expect(JSON.stringify(app.state)).not.toContain(
      f.pairing.identity.secretKey,
    );
    await app.select("s1");
    expect(f.sent.some((frame) => frame.method === "session.resume")).toBe(
      true,
    );
    expect(
      f.sent.every((frame) =>
        [
          "hello",
          "session.current",
          "session.list",
          "messages.read",
          "session.resume",
          "command.receipt",
        ].includes(frame.method),
      ),
    ).toBe(true);
    f.close(1006);
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(
      f.sent.filter((frame) => frame.method === "session.resume"),
    ).toHaveLength(1);
    let finishErase!: () => void;
    const originalErase = f.store.erase.getMockImplementation()!;
    f.store.erase.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        finishErase = done;
      });
      await originalErase();
    });
    const switching = expect(app.select("s1")).rejects.toThrow();
    f.close(4003);
    await switching;
    await vi.waitFor(() => expect(finishErase).toBeTypeOf("function"));
    expect(app.state.error).toContain("正在移除失效");
    finishErase();
    await vi.waitFor(() => expect(app.state.phase).toBe("revoked"));
    expect(app.state.messages).toEqual([]);
    expect(f.store.erase).toHaveBeenCalled();
    expect(f.credential).toBeNull();
  } finally {
    app.dispose();
  }
});
it("fences a secure-store load when the app backgrounds or forgets, and never connects from it", async () => {
  const f = fixture();
  let resolve!: (value: string) => void;
  f.store.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const app = new MobileController(f.store, f.options);
  const restore = app.restore();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  app.suspend();
  resolve(JSON.stringify(f.pairing));
  await restore;
  expect(f.sent).toEqual([]);
  expect(app.state.phase).toBe("background");
  await app.forget();
  expect(app.state.phase).toBe("unpaired");
  app.dispose();
});
it("keeps a persisted enrollment after QR expiry but refuses a revoked token before opening a socket", async () => {
  const f = fixture();
  f.pairing.expires = Date.now() - 1;
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => "revoked",
  });
  try {
    await app.restore();
    expect(app.state.phase).toBe("revoked");
    expect(f.sent).toEqual([]);
    expect(f.credential).toBeNull();
  } finally {
    app.dispose();
  }
});

it("restores the same granted host task after a lost selection acknowledgement, app recreation and host restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-mobile-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  const config = {
    relay: f.pairing.relay,
    hostId: f.pairing.hostId,
    publicKey: f.host.publicKey,
    devices: {
      [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
    },
  };
  await writeFile(join(home, "remote.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  let host = await serveSharedHost({ home, cwd, demo: true });
  let wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  let local = new ClientConnection(wire.scope, wire, clock);
  let app = new MobileController(f.store, f.options);
  try {
    await local.connected();
    const session = (await local.request("session.create")) as any;
    await local.request("session.create"); // A second, ungranted task must stay invisible.
    await local.request("session.resume", { sessionId: session.id });
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() =>
      expect(app.state.sessions.map((s) => s.id)).toEqual([session.id]),
    );
    f.dropResume();
    await expect(app.select(session.id)).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(app.state.session?.id).toBe(session.id));
    await vi.waitFor(() => expect(app.state.unknown).toBe(0));
    expect(f.sent.filter((f) => f.method === "session.resume")).toHaveLength(1);
    await local.request("prompt", { text: "mobile recovery proof" });
    await vi.waitFor(() => expect(local.state.busy).toBe(false));
    await vi.waitFor(() =>
      expect(
        app.state.messages.some((m) => m.message.role === "assistant"),
      ).toBe(true),
    );
    const text = app.state.messages.map((m) => m.message.text);
    app.suspend();
    expect(app.state.messages).toEqual([]);
    expect(local.state.session?.id).toBe(session.id);
    app.dispose();
    app = new MobileController(f.store, f.options);
    await app.restore();
    await vi.waitFor(() =>
      expect(app.state.messages.map((m) => m.message.text)).toEqual(text),
    );
    app.suspend();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    host = await serveSharedHost({ home, cwd, demo: true });
    wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
    bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
    local = new ClientConnection(wire.scope, wire, clock);
    await local.connected();
    await app.restore();
    await vi.waitFor(() =>
      expect(app.state.messages.map((m) => m.message.text)).toEqual(text),
    );
    expect(app.state.session?.id).toBe(session.id);
    expect(f.sent.filter((f) => f.method === "session.resume")).toHaveLength(1);
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: null,
    });
    await vi.waitFor(() => expect(app.state.session).toBeNull());
    await vi.waitFor(() => expect(app.state.sessions).toEqual([]));
    expect(app.state.messages).toEqual([]);
  } finally {
    app.dispose();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
