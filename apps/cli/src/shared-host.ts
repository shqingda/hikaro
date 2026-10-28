import { createServer, type Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, open, unlink } from "node:fs/promises";
import { constants, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import {
  hostEndpoint,
  type HostDescriptor,
} from "../../../packages/host/src/endpoint.ts";
import { SQLiteStore } from "../../../packages/storage/src/index.ts";
import { JsonLines, Command } from "../../../packages/protocol/src/index.ts";
import type { RuntimeOptions } from "../../../packages/runtime/src/index.ts";
import { serveRpc } from "./rpc.ts";

/** One Runtime for all authenticated local views and the encrypted relay bridge. */
export async function serveSharedHost(
  options: Omit<RuntimeOptions, "approve">,
) {
  if (process.platform === "win32")
    throw Error("Shared host currently requires Unix sockets");
  const endpoint = await hostEndpoint(options);
  const store = await SQLiteStore.open(join(endpoint.home, "sessions.sqlite"));
  const instanceId = randomUUID();
  if (
    !(await store.claimHost(endpoint.cwd, instanceId).catch(async (e) => {
      await store.close();
      throw e;
    }))
  ) {
    await store.close();
    throw Error("A shared host already owns this workspace and home");
  }
  const descriptor: HostDescriptor = {
    key: endpoint.key,
    instanceId,
    localToken: randomBytes(32).toString("base64url"),
    bridgeToken: randomBytes(32).toString("base64url"),
  };
  const input = new PassThrough();
  const clients = new Set<Socket>();
  const routes = new Map<string, Socket>();
  let bridge: Socket | undefined;
  let closing = false;
  const deliver = (socket: Socket | undefined, message: unknown) => {
    if (!socket || socket.destroyed) return;
    const line = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(line) > 1_048_576 ||
      socket.writableLength + Buffer.byteLength(line) > 2_000_000
    )
      socket.destroy();
    else socket.write(line);
  };
  const outputParser = new JsonLines((raw) => {
    const message = raw as { scope?: string };
    if (typeof message.scope === "string")
      deliver(routes.get(message.scope), message);
  });
  const output = new Writable({
    write(chunk, _encoding, done) {
      try {
        outputParser.push(chunk);
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
  const server = createServer((socket) => {
    if (closing || clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    let mode: "local" | "bridge" | undefined, scope: string | undefined;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const parser = new JsonLines((raw) => {
      if (!mode) {
        const p = raw as Record<string, unknown>;
        const expected =
          p.mode === "local"
            ? descriptor.localToken
            : p.mode === "bridge"
              ? descriptor.bridgeToken
              : "";
        if (
          p.type !== "attach" ||
          typeof p.token !== "string" ||
          p.token.length !== expected.length ||
          !expected ||
          !timingSafeEqual(Buffer.from(p.token), Buffer.from(expected))
        )
          throw Error("Host authentication failed");
        if (p.mode === "local") {
          if (
            typeof p.clientId !== "string" ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(p.clientId)
          )
            throw Error("Invalid client identity");
          scope = "local:" + p.clientId;
          const previous = routes.get(scope);
          routes.set(scope, socket);
          previous?.end(
            JSON.stringify({
              type: "connection.replaced",
              scope,
              hostInstanceId: instanceId,
            }) + "\n",
          );
          mode = "local";
        } else {
          const previous = bridge;
          bridge = socket;
          previous?.end(
            JSON.stringify({
              type: "connection.replaced",
              hostInstanceId: instanceId,
            }) + "\n",
          );
          mode = "bridge";
        }
        clearTimeout(timer);
        deliver(socket, {
          type: "attached",
          scope,
          hostInstanceId: instanceId,
        });
        return;
      }
      if (
        (mode === "local" && routes.get(scope!) !== socket) ||
        (mode === "bridge" && bridge !== socket)
      )
        throw Error("Client connection replaced");
      const command = Command.parse(raw);
      if (mode === "local") command.scope = scope;
      else {
        if (!command.scope || !/^[A-Za-z0-9_-]{43}$/.test(command.scope))
          throw Error("Invalid bridge scope");
        if (!routes.has(command.scope) && routes.size >= 64)
          throw Error("Host route capacity exceeded");
        routes.set(command.scope, socket);
      }
      const line = JSON.stringify(command) + "\n";
      if (input.writableLength + Buffer.byteLength(line) > 2_000_000)
        throw Error("Host input capacity exceeded");
      input.write(line);
    });
    socket.on("data", (chunk) => {
      try {
        parser.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      clients.delete(socket);
      if (bridge === socket) bridge = undefined;
      for (const [key, target] of routes)
        if (target === socket) routes.delete(key);
      // Views disconnect; execution, ownership and pending approvals remain at host.
    });
  });
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    unwatchFile(join(endpoint.home, "remote.json"));
    for (const socket of clients) socket.destroy();
    if (server.listening)
      await new Promise<void>((done) => server.close(() => done()));
    await Promise.all([
      unlink(endpoint.socket).catch(() => {}),
      unlink(endpoint.metadata).catch(() => {}),
    ]);
    await store.releaseHost(endpoint.cwd, instanceId);
  };
  let rpc: Awaited<ReturnType<typeof serveRpc>> | undefined;
  try {
    await unlink(endpoint.socket).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    const { loadSavedPermissionMode } =
      await import("../../../packages/runtime/src/permissions.ts");
    rpc = await serveRpc(
      {
        ...options,
        permissionMode:
          options.permissionMode ??
          (await loadSavedPermissionMode(endpoint.home, endpoint.cwd)),
        home: endpoint.home,
        cwd: endpoint.cwd,
      },
      { input, output, error: process.stderr },
      {
        instanceId,
        store,
        localScope: (scope) => scope.startsWith("local:"),
        defaultDeviceControl: true,
        pairedDevice: async (scope) => {
          const { readConfig } =
            await import("../../../packages/remote/src/host-store.ts");
          const device = (await readConfig(endpoint.home)).devices[scope];
          return !!device && device.expires === undefined;
        },
        beforeClose: cleanup,
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      void rpc?.close();
    });
    await chmod(endpoint.socket, 0o600);
    const file = await open(
      endpoint.metadata,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(descriptor));
      await file.sync();
    } finally {
      await file.close();
    }
    let checking = false;
    watchFile(
      join(endpoint.home, "remote.json"),
      { interval: 1000, persistent: false },
      () => {
        if (checking || closing) return;
        checking = true;
        void (async () => {
          const { readConfig } =
            await import("../../../packages/remote/src/host-store.ts");
          const config = await readConfig(endpoint.home);
          for (const scope of rpc!.remoteScopes())
            if (
              !config.devices[scope] ||
              config.devices[scope]!.expires !== undefined
            )
              await rpc!.revokeClient(scope);
        })()
          .catch(() => {
            /* Invalid metadata cannot authorize requests; per-command checks fail closed. */
          })
          .finally(() => {
            checking = false;
          });
      },
    );
    return { endpoint, close: () => rpc!.close() };
  } catch (error) {
    if (rpc) await rpc.close();
    else {
      await cleanup();
      await store.close();
    }
    throw error;
  }
}
