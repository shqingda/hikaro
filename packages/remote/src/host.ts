import WebSocket from "ws";
import { watchFile, unwatchFile } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createIdentity,
  SecureChannel,
  randomToken,
  isToken,
  isRecord,
} from "../../crypto/src/index.ts";
import { SharedHostClient } from "../../host/src/client.ts";
import { Command, isControlMethod } from "../../protocol/src/index.ts";
import { validateRelay, type Pairing } from "./client.ts";
import {
  loadHost as load,
  readConfig,
  writeConfig as saveConfig,
  withConfigLock,
  keychainStore,
  type HostConfig,
  type HostSecret as Secret,
} from "./host-store.ts";
const configPath = (home: string) => join(home, "remote.json");
async function post(
  config: HostConfig,
  path: string,
  token: string,
  data: unknown,
) {
  const response = await fetch(
    validateRelay(config.relay).replace(/^wss:/, "https:") +
      `/hosts/${config.hostId}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw Error(`Relay ${path} failed (${response.status})`);
}
export async function pairDevice(options: {
  home?: string;
  relay?: string;
  bootstrap?: string;
}) {
  const home = options.home ?? join(homedir(), ".hikaro");
  return withConfigLock(home, async () => {
    let config: HostConfig, secret: Secret;
    try {
      ({ config, secret } = await load(home));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!options.relay || !options.bootstrap)
        throw Error(
          "First pairing requires --relay wss://… and HIKARO_RELAY_BOOTSTRAP",
        );
      secret = { identity: createIdentity(), token: randomToken() };
      config = {
        relay: validateRelay(options.relay),
        hostId: randomToken(),
        publicKey: secret.identity.publicKey,
        registered: false,
        devices: {},
      };
      await keychainStore.set(`host:${config.hostId}`, JSON.stringify(secret));
      await saveConfig(home, config);
    }
    if (config.registered === false) {
      if (!options.bootstrap)
        throw Error("Host registration requires HIKARO_RELAY_BOOTSTRAP");
      await post(config, "register", options.bootstrap, {
        token: secret.token,
      });
      config.registered = true;
      await saveConfig(home, config);
    }
    if (Object.keys(config.devices).length >= 32)
      throw Error("Revoke an old device before pairing another");
    const identity = createIdentity(),
      deviceId = randomToken(),
      token = randomToken(),
      expires = Date.now() + 300000;
    await post(config, "enroll", secret.token, { id: deviceId, token });
    config.devices[deviceId] = { publicKey: identity.publicKey, expires };
    await saveConfig(home, config);
    const pairing: Pairing = {
      v: 1,
      relay: config.relay,
      hostId: config.hostId,
      hostKey: config.publicKey,
      deviceId,
      token,
      identity,
      expires,
    };
    return "hikaro://pair#" + encodeURIComponent(JSON.stringify(pairing));
  });
}
export async function revokeDevice(home: string | undefined, id: string) {
  if (!isToken(id)) throw Error("Invalid device ID");
  const dir = home ?? join(homedir(), ".hikaro");
  return withConfigLock(dir, async () => {
    const { config, secret } = await load(dir);
    delete config.devices[id];
    await saveConfig(dir, config);
    await post(config, "revoke", secret.token, { id });
  });
}
export interface HostRpc {
  request(
    method: string,
    params?: Record<string, unknown>,
    pi?: boolean,
    options?: { id?: string; scope?: string },
  ): Promise<any>;
}
/** Scope and id are injected from authenticated transport identity, never trusted from the handset. */
export async function dispatchRemote(
  rpc: HostRpc,
  deviceId: string,
  raw: unknown,
) {
  const command = Command.parse(raw);
  const stableId = (id: string) =>
    createHash("sha256")
      .update(deviceId + "\0" + id)
      .digest("hex");
  let targetId = command.id;
  let params = command.params;
  if (command.method === "command.receipt") {
    if (
      typeof params.commandId !== "string" ||
      !params.commandId ||
      params.commandId.length > 128
    )
      throw Error("Invalid receipt command ID");
    targetId = params.commandId;
    params = { ...params, commandId: stableId(targetId) };
  }
  const result = await rpc.request(command.method, params, false, {
    id: stableId(command.id),
    scope: deviceId,
  });
  // Handsets retain their original IDs; the host-only namespace stays internal.
  if (result?.receipt && typeof result.receipt === "object")
    return { ...result, receipt: { ...result.receipt, id: targetId } };
  return result;
}
async function confirmDevice(deviceId: string) {
  if (!process.stdin.isTTY) return false;
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (
      (
        await input.question(
          `Allow device ${deviceId.slice(0, 8)} to control this workspace? Type allow: `,
        )
      ).trim() === "allow"
    );
  } finally {
    input.close();
  }
}
export async function serveRemote(options: {
  cwd: string;
  home?: string;
  approveDevice?: (id: string) => Promise<boolean>;
}) {
  const home = options.home ?? join(homedir(), ".hikaro");
  let { config, secret } = await load(home).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Error(
        "尚未配置手机连接。请正常启动 hikaro，在 TUI 输入 /pair 完成配置与扫码配对。",
      );
    throw error;
  });
  let stopped = false,
    socket: WebSocket | undefined,
    retry = 0,
    generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let configWrites = Promise.resolve();
  const rpc = await SharedHostClient.connect({
    cwd: options.cwd,
    home,
    mode: "bridge",
  });
  type Peer = {
    channel: SecureChannel;
    ready: boolean;
    connectionId: string;
    chain: Promise<void>;
    queued: number;
    bytes: number;
    requests: number;
    requestBytes: number;
  };
  const peers = new Map<string, Peer>();
  const activeScopes = new Set<string>();
  const drop = (id: string, cancel = false) => {
    peers.delete(id);
    if (cancel) {
      activeScopes.delete(id);
      void rpc
        .request("client.detach", { cancel: true }, false, { scope: id })
        .catch(() => {});
    }
  };
  const frame = (id: string, peer: Peer, body: string) => {
    if (peers.get(id) !== peer || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount + body.length > 2_000_000) {
      socket.close(1013, "Backpressure");
      return;
    }
    socket.send(
      JSON.stringify({ to: id, connectionId: peer.connectionId, body }),
    );
  };
  const send = (id: string, data: unknown) => {
    const peer = peers.get(id);
    if (peer?.ready && socket?.readyState === WebSocket.OPEN) {
      try {
        frame(id, peer, peer.channel.send(data));
      } catch {
        drop(id);
      }
    }
  };
  rpc.subscribe((message) => {
    if (message.type === "connection.replaced") {
      console.error(
        "Another relay bridge attached to this host; this bridge is closing.",
      );
      void shutdown();
      return;
    }
    if (typeof message.scope === "string") {
      send(message.scope, message);
      if (message.type === "event" && message.event.type === "run.end")
        void post(config, "notify-enqueue", secret.token, {
          deviceId: message.scope,
          id: String(message.event.data.runId),
        }).catch(() => {});
    }
  });
  rpc.onConnection?.((connected) => {
    for (const id of peers.keys())
      send(id, {
        type: "connection",
        status: connected ? "connected" : "disconnected",
      });
  });
  const updateRevocations = async () => {
    const latest = await readConfig(home);
    for (const id of new Set([...peers.keys(), ...activeScopes]))
      if (!latest.devices[id]) drop(id, true);
    config = latest;
  };
  watchFile(configPath(home), { interval: 1000, persistent: false }, () => {
    void updateRevocations().catch((error) => console.error(String(error)));
  });
  const handle = async (id: string, peer: Peer, message: any) => {
    if (peers.get(id) !== peer || message.connectionId !== peer.connectionId)
      return;
    const latest = await readConfig(home);
    if (peers.get(id) !== peer) return;
    const device = latest.devices[id];
    if (
      !device ||
      (device.expires !== undefined && device.expires < Date.now())
    ) {
      drop(id, true);
      return;
    }
    const result = peer.channel.receive(message.body);
    if (result.ready) {
      if (device.expires !== undefined) {
        const allowed = await (options.approveDevice ?? confirmDevice)(id);
        if (!allowed || peers.get(id) !== peer) {
          drop(id);
          return;
        }
        await post(latest, "activate", secret.token, { id });
        configWrites = configWrites.then(() =>
          withConfigLock(home, async () => {
            const fresh = await readConfig(home);
            if (!fresh.devices[id])
              throw Error("Device revoked during confirmation");
            delete fresh.devices[id]!.expires;
            await saveConfig(home, fresh);
            config = fresh;
          }),
        );
        await configWrites;
      }
      peer.ready = true;
    }
    if (result.reply) frame(id, peer, result.reply);
    if (Object.hasOwn(result, "data")) {
      const command = result.data;
      if (!isRecord(command) || typeof command.id !== "string")
        throw Error("Invalid command");
      const bytes = Buffer.byteLength(message.body);
      if (
        !isControlMethod(String(command.method)) &&
        (peer.requests >= 8 || peer.requestBytes + bytes > 2_000_000)
      ) {
        send(id, {
          type: "response",
          id: command.id,
          error: "Remote request capacity exceeded",
        });
        return;
      }
      peer.requests++;
      peer.requestBytes += bytes;
      // Authenticate/decrypt frames in order, but let the RPC scheduler order
      // commands. Waiting here would prevent later cancel/approval frames.
      const execute = async () => {
        try {
          let response: unknown;
          if (command.method === "push.register") {
            if (
              !isRecord(command.params) ||
              (command.params.token !== null &&
                (typeof command.params.token !== "string" ||
                  !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(
                    command.params.token,
                  )))
            )
              throw Error("Invalid push registration");
            await post(config, "push", secret.token, {
              deviceId: id,
              token: command.params.token,
            });
            response = { ok: true };
          } else {
            activeScopes.add(id);
            response = await dispatchRemote(rpc, id, command);
            // Push registration is implemented by this encrypted bridge, not
            // the local RPC server. Advertise it only on the remote channel.
            if (
              command.method === "hello" &&
              isRecord(response) &&
              Array.isArray(response.methods)
            )
              response = {
                ...response,
                methods: [...new Set([...response.methods, "push.register"])],
              };
          }
          send(id, { type: "response", id: command.id, result: response });
        } catch (error) {
          send(id, { type: "response", id: command.id, error: String(error) });
        }
      };
      void execute().finally(() => {
        peer.requests--;
        peer.requestBytes -= bytes;
      });
    }
  };
  const connect = () => {
    if (stopped) return;
    const current = ++generation;
    const ws = new WebSocket(
      `${config.relay}/hosts/${config.hostId}/host`,
      ["hikaro.v1"],
      {
        headers: { Authorization: `Bearer ${secret.token}` },
        maxPayload: 1_501_000,
        handshakeTimeout: 15000,
      },
    );
    socket = ws;
    let lastPong = Date.now();
    ws.on("open", () => {
      retry = 0;
      lastPong = Date.now();
      console.error("Hikaro host connected.");
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 75000) {
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 25000);
    });
    ws.on("message", (raw) => {
      if (current !== generation || stopped) return;
      if (raw.toString() === "pong") {
        lastPong = Date.now();
        return;
      }
      try {
        const message = JSON.parse(raw.toString());
        if (!isRecord(message) || !isToken(message.deviceId))
          throw Error("Invalid relay frame");
        const id = message.deviceId;
        if (message.type === "revoked") {
          drop(id, true);
          return;
        }
        if (message.type === "disconnected") {
          const peer = peers.get(id);
          if (peer?.connectionId === message.connectionId) drop(id);
          return;
        }
        if (message.type === "connected") {
          void readConfig(home)
            .then((latest) => {
              if (current !== generation || stopped) return;
              const device = latest.devices[id];
              if (
                !device ||
                (device.expires !== undefined && device.expires < Date.now()) ||
                typeof message.connectionId !== "string"
              )
                return;
              const peer: Peer = {
                channel: new SecureChannel(
                  "host",
                  secret.identity,
                  device.publicKey,
                ),
                ready: false,
                connectionId: message.connectionId,
                chain: Promise.resolve(),
                queued: 0,
                bytes: 0,
                requests: 0,
                requestBytes: 0,
              };
              peers.set(id, peer);
              frame(id, peer, peer.channel.hello());
            })
            .catch((error) => console.error(String(error)));
          return;
        }
        const peer = peers.get(id);
        if (
          !peer ||
          typeof message.body !== "string" ||
          message.connectionId !== peer.connectionId
        )
          return;
        if (peer.queued >= 8 || peer.bytes + message.body.length > 2_000_000) {
          drop(id);
          return;
        }
        peer.queued++;
        peer.bytes += message.body.length;
        peer.chain = peer.chain
          .then(() => handle(id, peer, message))
          .catch((error) => {
            drop(id);
            console.error(`Remote request rejected: ${String(error)}`);
          })
          .finally(() => {
            peer.queued--;
            peer.bytes -= (message.body as string).length;
          });
      } catch {
        ws.close(1003, "Invalid frame");
      }
    });
    ws.on("error", (error) => console.error(error.message));
    ws.on("close", () => {
      if (current !== generation) return;
      clearInterval(heartbeat);
      peers.clear();
      if (!stopped)
        retryTimer = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)),
        );
    });
  };
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    generation++;
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    unwatchFile(configPath(home));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    socket?.close();
    await rpc.close();
  }
  connect();
  const onSignal = () => void shutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { close: shutdown };
}
