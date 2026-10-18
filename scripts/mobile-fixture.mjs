// Isolated native validation only: synthetic task, temporary secrets, loopback TLS.
// Supply a private directory containing server-key.pem/server.pem and trust its CA
// only in a disposable simulator. Never use a real Hikaro home with this fixture.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";
import {
  keychainStore,
  writeConfig,
} from "../packages/remote/src/host-store.ts";
import { serveRemote, revokeDevice } from "../packages/remote/src/host.ts";
const directory = process.env.HIKARO_MOBILE_FIXTURE_DIR;
if (!directory || !process.env.NODE_EXTRA_CA_CERTS)
  throw Error(
    "Set HIKARO_MOBILE_FIXTURE_DIR and NODE_EXTRA_CA_CERTS to isolated TLS fixture files",
  );
const require = createRequire(import.meta.url);
const relayRequire = createRequire(resolve("apps/relay/package.json"));
const wranglerRequire = createRequire(
  relayRequire.resolve("wrangler/package.json"),
);
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
  token = randomToken();
const identity = createIdentity(),
  device = createIdentity(),
  deviceId = randomToken(),
  deviceToken = randomToken();
const relay = "wss://127.0.0.1:8443",
  home = join(directory, "home"),
  cwd = join(home, "workspace");
await mkdir(cwd, { recursive: true, mode: 0o700 });
const mf = new Miniflare(
  convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 8443,
    https: true,
    httpsKey: await readFile(join(directory, "server-key.pem"), "utf8"),
    httpsCert: await readFile(join(directory, "server.pem"), "utf8"),
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-10-01",
    durableObjects: { HOSTS: { className: "HostRelay", useSQLite: true } },
    bindings: { BOOTSTRAP_TOKEN: bootstrap },
    queueProducers: { NOTIFICATIONS: "notifications" },
  }),
);
await mf.ready;
const post = async (path, secret, body) => {
  const response = await mf.dispatchFetch(
    `https://localhost/hosts/${hostId}/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    },
  );
  if (response.status !== 200)
    throw Error(`Fixture ${path} failed: ${response.status}`);
};
await post("register", bootstrap, { token });
await post("enroll", token, { id: deviceId, token: deviceToken });
// This test identity can only see this synthetic task; no user Keychain is read.
keychainStore.get = async () => JSON.stringify({ identity, token });
await writeConfig(home, {
  relay,
  hostId,
  publicKey: identity.publicKey,
  devices: { [deviceId]: { publicKey: device.publicKey } },
});
await post("activate", token, { id: deviceId });
const host = await serveSharedHost({ home, cwd, demo: true });
const owner = await SharedHostClient.connect({
  home,
  cwd,
  clientId: "fixture-owner",
});
const session = await owner.request("session.create", {
  title: "M0 · 接续同一个任务",
});
await owner.request("prompt", {
  text: "验证手机只读恢复：电脑继续运行，手机安全接续。",
});
await owner.request("session.access", { deviceId, role: "view" });
const bridge = await serveRemote({ home, cwd });
async function pairing() {
  await writeFile(
    join(directory, "pairing.txt"),
    "hikaro://pair#" +
      encodeURIComponent(
        JSON.stringify({
          v: 1,
          relay,
          hostId,
          deviceId,
          token: deviceToken,
          identity: device,
          hostKey: identity.publicKey,
          expires: Date.now() + 300000,
        }),
      ),
    { mode: 0o600 },
  );
}
await pairing();
console.log(
  "Native fixture ready. Pairing is in the private fixture directory. Commands: refresh-code, update, revoke, offline, exit.",
);
const input = createInterface({ input: process.stdin });
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  input.close();
  await bridge.close();
  owner.close();
  await host.close();
  await mf.dispose();
}
input.on("line", (command) => {
  void (async () => {
    if (command === "refresh-code") await pairing();
    if (command === "update")
      await owner.request("prompt", { text: "断线期间的新增结果" });
    if (command === "revoke") await revokeDevice(home, deviceId);
    if (command === "offline") await bridge.close();
    if (command === "exit") await close();
    console.log("Fixture command completed: " + command);
  })().catch((error) => console.error(error.message));
});
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
