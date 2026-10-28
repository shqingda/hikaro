import { expect, it } from "vitest";
import WebSocket from "ws";
import { startLanServer } from "../packages/remote/src/lan.ts";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
import { validateLan } from "../packages/remote/src/client.ts";

it("only accepts private IPv4 LAN origins", () => {
  expect(validateLan("ws://192.168.1.20:43187")).toBe(
    "ws://192.168.1.20:43187",
  );
  for (const value of [
    "ws://example.com",
    "ws://8.8.8.8",
    "ws://127.0.0.1",
    "ws://192.168.1.2/path",
    "ws://user:pass@10.1.2.3",
    "ws://10.1.2.3?token=x",
  ])
    expect(() => validateLan(value)).toThrow();
});
it("LAN accepts known devices then carries the existing encrypted handshake without bearer credentials", async () => {
  const hostId = randomToken(),
    deviceId = randomToken();
  const hostIdentity = createIdentity(),
    deviceIdentity = createIdentity();
  const hostChannel = new SecureChannel(
    "host",
    hostIdentity,
    deviceIdentity.publicKey,
  );
  const deviceChannel = new SecureChannel(
    "device",
    deviceIdentity,
    hostIdentity.publicKey,
  );
  let authenticated = false;
  const server = await startLanServer({
    hostId,
    port: 0,
    hasDevice: async (id) => id === deviceId,
    onConnection(peer) {
      peer.onFrame((frame) => {
        const result = hostChannel.receive(frame);
        if (result.reply) peer.send(result.reply);
        if (result.ready) authenticated = true;
        if (result.data) peer.send(hostChannel.send({ echo: result.data }));
      });
      peer.send(hostChannel.hello());
    },
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/hosts/${hostId}/device/${deviceId}`,
    ["hikaro.v1"],
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const result = deviceChannel.receive(raw.toString());
        if (result.reply) ws.send(result.reply);
        if (result.ready) ws.send(deviceChannel.send({ hello: "你好" }));
        if (result.data) resolve(result.data);
      });
    });
    expect(result).toEqual({ echo: { hello: "你好" } });
    expect(authenticated).toBe(true);
    expect(
      (
        await fetch(
          `http://127.0.0.1:${server.port}/hosts/${hostId}/device-status/${randomToken()}`,
        )
      ).status,
    ).toBe(401);
  } finally {
    ws.terminate();
    await server.close();
  }
});

it("tries LAN without a bearer token then falls back to the relay when LAN closes", async () => {
  const { RemoteClient } = await import("../packages/remote/src/client.ts");
  const sockets: any[] = [];
  const calls: Array<{ url: string; protocols: string[] }> = [];
  const p = {
    v: 1 as const,
    relay: "wss://relay.example",
    hostId: randomToken(),
    deviceId: randomToken(),
    token: randomToken(),
    identity: createIdentity(),
    hostKey: createIdentity().publicKey,
    expires: Date.now() + 300000,
    lan: ["ws://192.168.1.20:43187"],
  };
  const client = new RemoteClient(p, {
    socket(url, protocols) {
      calls.push({ url, protocols });
      const socket = {
        readyState: 0 as const,
        bufferedAmount: 0,
        send() {},
        close() {},
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
  });
  try {
    client.connect();
    expect(calls[0]?.protocols).toEqual(["hikaro.v1"]);
    expect(calls[0]?.url).toContain("ws://192.168.1.20:43187/");
    sockets[0].onclose({ code: 1006 });
    expect(calls[1]?.url).toContain("wss://relay.example/");
    expect(calls[1]?.protocols).toEqual(["hikaro.v1", "token." + p.token]);
  } finally {
    client.close();
  }
});

it.each(["heartbeat", "authentication"])(
  "rejects outstanding requests when an established LAN channel fails %s",
  async (failure) => {
    const { vi } = await import("vitest");
    const { RemoteClient } = await import("../packages/remote/src/client.ts");
    vi.useFakeTimers();
    const hostIdentity = createIdentity(),
      identity = createIdentity();
    const host = new SecureChannel("host", hostIdentity, identity.publicKey);
    const sent: string[] = [],
      events: any[] = [];
    const socket: any = {
      readyState: 1,
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(frame: string) {
        sent.push(frame);
      },
      close(code: number) {
        socket.onclose?.({ code });
      },
    };
    const factory = vi.fn(() => socket);
    const client = new RemoteClient(
      {
        v: 1,
        relay: "wss://relay.example",
        hostId: randomToken(),
        deviceId: randomToken(),
        token: randomToken(),
        identity,
        hostKey: hostIdentity.publicKey,
        expires: Date.now() + 300000,
        lan: ["ws://192.168.1.20:43187"],
      },
      { socket: factory, heartbeatMs: 10, reconnectMs: 1000 },
    );
    client.subscribe((event) => events.push(event));
    try {
      client.connect();
      socket.onopen();
      socket.onmessage({ data: host.hello() });
      socket.onmessage({ data: host.receive(sent.shift()!).reply! });
      expect(events.at(-1)).toMatchObject({ status: "connected" });
      let outcome: unknown;
      void client.request("session.list").catch((error) => {
        outcome = error;
      });
      if (failure === "heartbeat") await vi.advanceTimersByTimeAsync(40);
      else {
        socket.onmessage({ data: "{}" });
        await Promise.resolve();
      }
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("outcome may be unknown");
      expect(factory).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.status === "disconnected")).toBe(true);
      if (failure === "authentication")
        expect(events.at(-1)).toMatchObject({
          status: "blocked",
          reason: "authentication",
        });
    } finally {
      client.close();
      vi.useRealTimers();
    }
  },
);
