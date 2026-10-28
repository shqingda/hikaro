import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { validateLan } from "./client.ts";

export const LAN_PORT = 43187;
export function lanOrigins(port = LAN_PORT) {
  const origins = new Set<string>();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(utun|tun|tap|tailscale|docker|bridge|veth|lo)/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      try {
        origins.add(validateLan(`ws://${address.address}:${port}`));
      } catch {
        /* Non-LAN interface. */
      }
    }
  }
  return [...origins].slice(0, 4);
}
export type LanPeer = {
  deviceId: string;
  connectionId: string;
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  onFrame(fn: (frame: string) => void): void;
  onClose(fn: () => void): void;
};
/** LAN supplies only transport. The host's existing SecureChannel authenticates every device. */
export async function startLanServer(options: {
  hostId: string;
  port?: number;
  hasDevice(id: string): Promise<boolean>;
  onConnection(peer: LanPeer): void;
}) {
  const path = (raw: string | undefined, operation: string) => {
    const match = raw?.match(
      new RegExp(`^/hosts/${options.hostId}/${operation}/([A-Za-z0-9_-]{43})$`),
    );
    return match?.[1];
  };
  const server = createServer((request, response) => {
    void (async () => {
      const id = path(request.url, "device-status");
      const valid =
        request.method === "GET" && id && (await options.hasDevice(id));
      response.writeHead(valid ? 200 : 401, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify(
          valid
            ? { hostOnline: true, confirmed: true }
            : { error: "Unknown device" },
        ),
      );
    })().catch(() => {
      response.writeHead(503);
      response.end();
    });
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1_500_000,
    handleProtocols: (protocols) =>
      protocols.has("hikaro.v1") ? "hikaro.v1" : false,
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const id = path(request.url, "device");
      const protocols = request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((s) => s.trim());
      if (
        !id ||
        !protocols?.includes("hikaro.v1") ||
        !(await options.hasDevice(id))
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", () => {});
        options.onConnection({
          deviceId: id,
          connectionId: randomUUID(),
          send(frame) {
            if (ws.readyState === WebSocket.OPEN) {
              if (ws.bufferedAmount + frame.length > 2_000_000)
                ws.close(1013, "Backpressure");
              else ws.send(frame);
            }
          },
          close(code = 1000, reason = "Disconnected") {
            ws.close(code, reason);
          },
          onFrame(fn) {
            ws.on("message", (data, binary) => {
              if (binary) ws.close(1003, "Text frames required");
              else if (data.toString() === "ping") ws.send("pong");
              else fn(data.toString());
            });
          },
          onClose(fn) {
            ws.once("close", fn);
          },
        });
      });
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? LAN_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    origins: lanOrigins(port),
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
