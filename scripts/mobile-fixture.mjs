// Local mobile lab only. Its identities and workspace never reach real Keychain.
// TLS and production pairing/grant checks stay enabled.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { randomToken } from "../packages/crypto/src/index.ts";
import {
  keychainStore,
  readConfig,
} from "../packages/remote/src/host-store.ts";
import {
  serveRemote,
  revokeDevice,
  pairDevice,
} from "../packages/remote/src/host.ts";
import { openLab } from "./mobile-lab-files.mjs";

const directory = process.env.HIKARO_MOBILE_FIXTURE_DIR;
if (!directory || !process.env.NODE_EXTRA_CA_CERTS)
  throw Error(
    "Internal relay fixture requires an owned private directory and TLS files; use pnpm dev:sim for the existing simulator",
  );
const lab = await openLab(directory);
const port = Number(process.env.HIKARO_MOBILE_LAB_PORT ?? 8443);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid lab relay port");
const device = process.env.HIKARO_MOBILE_LAB_DEVICE;
if (device && (await lab.read("simulator.json"))?.udid !== device)
  throw Error("Simulator is not owned by this lab");
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
let state = (await lab.read("lab.json")) ?? { bootstrap: randomToken() };
await lab.write("lab.json", state);
const home = join(directory, "home"),
  cwd = join(home, "workspace");
await mkdir(cwd, { recursive: true, mode: 0o700 });
const secrets = (await lab.read("secrets.json")) ?? {};
keychainStore.get = async (account) => secrets[account];
keychainStore.set = async (account, value) => {
  secrets[account] = value;
  await lab.write("secrets.json", secrets);
};
keychainStore.delete = async (account) => {
  delete secrets[account];
  await lab.write("secrets.json", secrets);
};
const report = (event) => {
  if (process.connected) process.send(event);
};
const pending = new Map();
const allowed = new Set();
let mf,
  host,
  owner,
  bridge,
  closing = false;
function clearPending() {
  for (const resolvers of pending.values())
    for (const resolve of resolvers) resolve(false);
  pending.clear();
}
async function start() {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port,
      https: true,
      httpsKey: await readFile(join(directory, "server-key.pem"), "utf8"),
      httpsCert: await readFile(join(directory, "server.pem"), "utf8"),
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      durableObjects: { HOSTS: { className: "HostRelay", useSQLite: true } },
      resourcePersistencePath: join(directory, "relay-state"),
      bindings: { BOOTSTRAP_TOKEN: state.bootstrap },
      queueProducers: { NOTIFICATIONS: "notifications" },
    }),
  );
  await mf.ready;
  host = await serveSharedHost({ home, cwd, demo: true });
  owner = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "mobile-lab-owner",
  });
  if (state.sessionId)
    await owner.request("session.resume", { sessionId: state.sessionId });
  else {
    const session = await owner.request("session.create");
    state.sessionId = session.id;
    await owner.request("session.rename", { title: "M0 · 接续同一个任务" });
    await lab.write("lab.json", state);
    await update("验证手机只读恢复：电脑继续运行，手机安全接续。");
  }
  if (!state.deviceId) await pair();
  await online();
}
async function update(text = "断线期间的新增结果") {
  await owner.request("prompt", { text });
  const deadline = Date.now() + 10000;
  while ((await owner.request("session.current")).busy) {
    if (Date.now() > deadline) throw Error("Demo task timed out");
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function online() {
  if (bridge) return;
  bridge = await serveRemote({
    home,
    cwd,
    approveDevice: async (id) => {
      if (id !== state.deviceId) return false;
      if (allowed.has(id)) return true;
      console.log(
        `待确认测试设备 ${id.slice(0, 8)}。核对手机主机信息后，在此输入 allow。`,
      );
      report({ type: "pending", deviceId: id });
      return new Promise((resolve) => {
        if (!pending.has(id)) pending.set(id, new Set());
        pending.get(id).add(resolve);
      });
    },
  });
}
async function offline() {
  clearPending();
  await bridge?.close();
  bridge = undefined;
}
async function stop() {
  await offline();
  owner?.close();
  owner = undefined;
  await host?.close();
  host = undefined;
  await mf?.dispose();
  mf = undefined;
}
async function copy() {
  if (!device) return;
  const text = await lab.readText("pairing.txt");
  if (!text) throw Error("Generate a pairing code first");
  await new Promise((resolve, reject) => {
    const child = spawn("xcrun", ["simctl", "pbcopy", device], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Cannot copy pairing to lab simulator")),
    );
    child.stdin.end(text);
  });
  console.log(
    "配对码已放入测试模拟器剪贴板：长按 App 输入框，选择粘贴。五分钟内有效。",
  );
}
async function pair() {
  if (state.deviceId) await revokeDevice(home, state.deviceId);
  clearPending();
  allowed.clear();
  const uri = await pairDevice({
    home,
    relay: `wss://127.0.0.1:${port}`,
    bootstrap: state.bootstrap,
  });
  state.deviceId = JSON.parse(
    decodeURIComponent(uri.slice("hikaro://pair#".length)),
  ).deviceId;
  await lab.writeText("pairing.txt", uri);
  await lab.write("lab.json", state);
  await copy();
}
async function status() {
  const config = await readConfig(home);
  const confirmed =
    config.devices[state.deviceId]?.expires === undefined &&
    !!config.devices[state.deviceId];
  return {
    sessionId: state.sessionId,
    deviceId: state.deviceId,
    confirmed,
    online: !!bridge,
    relay: `wss://127.0.0.1:${port}`,
  };
}
const help =
  "命令：copy 复制现有配对码；pair 重新配对；allow 确认设备；grant 授予查看权；unshare 撤销查看权；update 新增输出；offline / online 断线恢复；reopen 重开 App；restart 重启 relay 和 host；status 查看状态；quit 退出（保留数据）。";
async function command(text) {
  switch (text.trim()) {
    case "allow": {
      if (!pending.has(state.deviceId))
        throw Error(
          "No pending device to confirm; connect the mobile app first",
        );
      allowed.add(state.deviceId);
      for (const resolve of pending.get(state.deviceId)) resolve(true);
      pending.delete(state.deviceId);
      const deadline = Date.now() + 10000;
      while (!(await status()).confirmed) {
        if (Date.now() > deadline)
          throw Error(
            "Device confirmation timed out; reconnect the app and try allow again",
          );
        await new Promise((done) => setTimeout(done, 25));
      }
      break;
    }
    case "grant":
      if (!(await status()).confirmed)
        throw Error("Device must be confirmed before granting a task");
      await owner.request("session.access", {
        deviceId: state.deviceId,
        role: "view",
      });
      break;
    case "unshare":
      await owner.request("session.access", {
        deviceId: state.deviceId,
        role: null,
      });
      break;
    case "copy":
      await copy();
      break;
    case "pair":
      await pair();
      break;
    case "update":
      await update();
      break;
    case "offline":
      await offline();
      break;
    case "online":
      await online();
      break;
    case "restart":
      await stop();
      await start();
      break;
    case "revoke":
      await revokeDevice(home, state.deviceId);
      break;
    case "reopen":
      if (!device) throw Error("No native test simulator selected");
      await promisify(execFile)("xcrun", [
        "simctl",
        "terminate",
        device,
        "dev.hikaro.mobile",
      ]).catch(() => {});
      await promisify(execFile)("xcrun", [
        "simctl",
        "openurl",
        device,
        "hikaro-companion://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081",
      ]);
      break;
    case "status":
    case "":
      return status();
    case "help":
      console.log(help);
      break;
    case "quit":
    case "exit":
      await close();
      return { stopped: true };
    default:
      throw Error("Unknown lab command. " + help);
  }
  return status();
}
const input = createInterface({ input: process.stdin });
let chain = Promise.resolve(),
  startup,
  ready = false;
async function close() {
  if (closing) return;
  closing = true;
  input.close();
  await startup?.catch(() => {});
  await stop();
  process.disconnect?.();
}
function enqueue(text, id) {
  chain = chain.then(async () => {
    try {
      const result = await command(text);
      if (id !== undefined) report({ id, result });
      else console.log(result);
    } catch (error) {
      if (id !== undefined) report({ id, error: error.message });
      else console.error(error.message);
    }
  });
}
const requestStop = () => (ready ? enqueue("quit") : void close());
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
try {
  startup = start();
  await startup;
  ready = true;
  if (!closing) {
    const current = await status();
    console.log("本地 relay / 演示任务已就绪。", current);
    console.log(help);
    console.log(
      "配对信息：" +
        join(directory, "pairing.txt") +
        "（含测试凭据，请勿转发）。",
    );
    report({ type: "ready", ...current });
    input.on("line", (line) => enqueue(line));
    process.on("message", (message) => {
      if (typeof message?.command === "string")
        enqueue(message.command, message.id);
    });
  }
} catch (error) {
  await close();
  throw error;
}
