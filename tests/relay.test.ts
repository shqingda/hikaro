import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  randomToken,
  createIdentity,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
const require = createRequire(import.meta.url);
const relayRequire = createRequire(resolve("apps/relay/package.json"));
const wranglerRequire = createRequire(
  relayRequire.resolve("wrangler/package.json"),
);
it("authenticates the local Cloudflare relay, forwards encrypted frames, and revokes a connected device", async () => {
  const { Miniflare, convertV4MiniflareOptions } = require(
    wranglerRequire.resolve("miniflare"),
  );
  const built = await build({
    entryPoints: ["apps/relay/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const bootstrap = randomToken(),
    hostId = randomToken(),
    hostToken = randomToken(),
    deviceId = randomToken(),
    deviceToken = randomToken();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: built.outputFiles![0]!.text,
      compatibilityDate: "2026-10-01",
      durableObjects: { HOSTS: { className: "HostRelay", useSQLite: true } },
      bindings: { BOOTSTRAP_TOKEN: bootstrap },
      queueProducers: { NOTIFICATIONS: "notifications" },
    }),
  );
  const url = `http://localhost/hosts/${hostId}`;
  const post = (path: string, token: string, data: unknown) =>
    mf.dispatchFetch(url + "/" + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
  try {
    expect((await post("register", "wrong", { token: hostToken })).status).toBe(
      401,
    );
    expect(
      (await post("register", bootstrap, { token: hostToken })).status,
    ).toBe(200);
    expect(
      (await post("register", bootstrap, { token: hostToken })).status,
    ).toBe(200);
    expect(
      (await post("enroll", hostToken, { id: deviceId, token: deviceToken }))
        .status,
    ).toBe(200);
    const hres = await mf.dispatchFetch(url + "/host", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "hikaro.v1",
        Authorization: `Bearer ${hostToken}`,
      },
    });
    expect(hres.status).toBe(101);
    const host = hres.webSocket;
    host.accept();
    const hostMessages: any[] = [];
    host.addEventListener("message", (e: any) =>
      hostMessages.push(JSON.parse(e.data)),
    );
    const dres = await mf.dispatchFetch(url + "/device/" + deviceId, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `hikaro.v1, token.${deviceToken}`,
      },
    });
    expect(dres.status).toBe(101);
    const device = dres.webSocket;
    device.accept();
    const deviceMessages: string[] = [];
    device.addEventListener("message", (e: any) => deviceMessages.push(e.data));
    const until = async (test: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!test()) {
        if (Date.now() > deadline) throw Error("Relay event timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await until(() => hostMessages.length > 0);
    const connectionId = hostMessages[0].connectionId;
    const a = createIdentity(),
      b = createIdentity();
    const h = new SecureChannel("host", a, b.publicKey),
      d = new SecureChannel("device", b, a.publicKey);
    host.send(JSON.stringify({ to: deviceId, connectionId, body: h.hello() }));
    await until(() => deviceMessages.length > 0);
    device.send(d.receive(deviceMessages.shift()!).reply!);
    await until(() => hostMessages.some((m) => m.body));
    const proof = hostMessages.find((m) => m.body);
    const ready = h.receive(proof.body);
    expect((await post("activate", hostToken, { id: deviceId })).status).toBe(
      200,
    );
    host.send(
      JSON.stringify({ to: deviceId, connectionId, body: ready.reply }),
    );
    await until(() => deviceMessages.length > 0);
    expect(d.receive(deviceMessages.shift()!).ready).toBe(true);
    host.send(
      JSON.stringify({
        to: deviceId,
        connectionId,
        body: h.send({ text: "private payload" }),
      }),
    );
    await until(() => deviceMessages.length > 0);
    const cipher = deviceMessages.shift()!;
    expect(cipher).not.toContain("private payload");
    expect(d.receive(cipher).data).toEqual({ text: "private payload" });
    expect((await post("revoke", hostToken, { id: deviceId })).status).toBe(
      200,
    );
    await until(() => hostMessages.some((m) => m.type === "revoked"));
    const revoked = await mf.dispatchFetch(url + "/device/" + deviceId, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `hikaro.v1, token.${deviceToken}`,
      },
    });
    expect(revoked.status).toBe(401);
    host.close();
    device.close();
  } finally {
    await mf.dispose();
  }
}, 20000);
