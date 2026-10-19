import { afterEach, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
import { serveRemote } from "../packages/remote/src/host.ts";

const state = vi.hoisted(() => ({
  socket: undefined as any,
  config: undefined as any,
  secret: undefined as any,
  watcher: undefined as (() => void) | undefined,
  request: vi.fn(),
  connectionOptions: undefined as any,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watchFile: (_path: string, _options: unknown, callback: () => void) => {
    state.watcher = callback;
  },
  unwatchFile: () => {},
}));
vi.mock("../packages/remote/src/host-store.ts", () => ({
  loadHost: async () => ({ config: state.config, secret: state.secret }),
  readConfig: async () => state.config,
  writeConfig: async () => {},
  withConfigLock: async (_home: string, body: () => Promise<unknown>) => body(),
  keychainStore: {},
}));
vi.mock("../packages/host/src/client.ts", () => ({
  SharedHostClient: {
    connect: async (options: unknown) => {
      state.connectionOptions = options;
      return {
        request: state.request,
        subscribe: () => () => {},
        onConnection: () => () => {},
        close: async () => {},
      };
    },
  },
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      sent: string[] = [];
      constructor() {
        super();
        state.socket = this;
      }
      send(frame: string) {
        this.sent.push(frame);
      }
      close() {}
    },
  };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  state.request.mockReset();
});

async function host(options: Partial<Parameters<typeof serveRemote>[0]> = {}) {
  const identity = createIdentity();
  const deviceIdentity = createIdentity();
  const deviceId = randomToken();
  const connectionId = "connection";
  state.secret = { identity, token: randomToken() };
  state.config = {
    relay: "wss://relay.example",
    hostId: randomToken(),
    publicKey: identity.publicKey,
    devices: { [deviceId]: { publicKey: deviceIdentity.publicKey } },
  };
  state.request.mockResolvedValue({});
  const server = await serveRemote({
    cwd: "/workspace",
    home: "/unused",
    ...options,
  });
  cleanups.push(() => server.close());
  const socket = state.socket;
  const incoming = (message: unknown) =>
    socket.emit("message", Buffer.from(JSON.stringify(message)));
  incoming({ type: "connected", deviceId, connectionId });
  await setImmediate();
  const device = new SecureChannel(
    "device",
    deviceIdentity,
    identity.publicKey,
  );
  const proof = device.receive(JSON.parse(socket.sent.at(-1)).body).reply!;
  incoming({ deviceId, connectionId, body: proof });
  await setImmediate();
  expect(device.receive(JSON.parse(socket.sent.at(-1)).body).ready).toBe(true);
  let sequence = 0;
  const send = (method: string) =>
    incoming({
      deviceId,
      connectionId,
      body: device.send({ id: `request-${sequence++}`, method, params: {} }),
    });
  return { deviceId, connectionId, incoming, send };
}

it("attaches the encrypted bridge to the existing workspace host", async () => {
  await host();
  expect(state.connectionOptions).toEqual({
    cwd: "/workspace",
    home: "/unused",
    mode: "bridge",
  });
});

it("forwards cancellation without waiting for a slow remote request", async () => {
  const remote = await host();
  let finish!: (value: unknown) => void;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  state.request.mockImplementation((method) =>
    method === "session.list" ? blocked : Promise.resolve({}),
  );
  remote.send("session.list");
  await setImmediate();
  remote.send("cancel");
  await setImmediate();
  try {
    expect(
      state.request.mock.calls.some(([method]) => method === "cancel"),
    ).toBe(true);
  } finally {
    finish({});
    await setImmediate();
  }
});

it("revokes a disconnected device's surviving RPC scope", async () => {
  const remote = await host();
  remote.send("prompt");
  await setImmediate();
  remote.incoming({
    type: "disconnected",
    deviceId: remote.deviceId,
    connectionId: remote.connectionId,
  });
  state.config = { ...state.config, devices: {} };
  state.watcher!();
  await setImmediate();
  expect(state.request.mock.calls).toContainEqual([
    "client.detach",
    { cancel: true },
    false,
    { scope: remote.deviceId },
  ]);
});
