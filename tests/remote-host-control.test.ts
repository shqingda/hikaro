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
  spawnArgs: [] as string[],
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
vi.mock("../packages/protocol/src/client.ts", () => ({
  ProcessClient: class {
    constructor(_command: string, args: string[]) {
      state.spawnArgs = args;
    }
    request = state.request;
    subscribe() {}
    onExit() {}
    async close() {}
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
    demo: true,
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

it("forwards the configured compatible endpoint to the RPC subprocess", async () => {
  const baseUrl = "http://127.0.0.1:11434/v1";
  await host({ demo: false, provider: "local", model: "test", baseUrl });
  expect(state.spawnArgs).toEqual(
    expect.arrayContaining([
      "--provider",
      "local",
      "--model",
      "test",
      "--base-url",
      baseUrl,
    ]),
  );
  expect(state.spawnArgs[state.spawnArgs.indexOf("--base-url") + 1]).toBe(
    baseUrl,
  );
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
