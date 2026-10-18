import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  access,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openLab, lockLab } from "./mobile-lab-files.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const run = async (command, args) =>
  (await exec(command, args, { cwd: ROOT, timeout: 120000 })).stdout;
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
async function foreground(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit" });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw Error(`${command} failed (${signal ?? code})`);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function certificates(lab) {
  const path = (name) => join(lab.directory, name);
  if (!(await exists(path("ca.pem")))) {
    console.log(
      "创建仅用于专用测试模拟器的本地 CA；不修改 macOS 或日常模拟器的信任设置。",
    );
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path("ca-key.pem"),
      "-out",
      path("ca.pem"),
      "-days",
      "365",
      "-subj",
      "/CN=Hikaro Mobile Lab CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  }
  await run("openssl", [
    "x509",
    "-checkend",
    "86400",
    "-noout",
    "-in",
    path("ca.pem"),
  ]);
  const valid = await run("openssl", [
    "x509",
    "-checkend",
    "86400",
    "-noout",
    "-in",
    path("server.pem"),
  ]).then(
    () => true,
    () => false,
  );
  if (valid) return;
  await run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path("server-key.pem"),
    "-out",
    path("server.csr"),
    "-subj",
    "/CN=localhost",
  ]);
  await writeFile(
    path("server.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
    { mode: 0o600 },
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    path("server.csr"),
    "-CA",
    path("ca.pem"),
    "-CAkey",
    path("ca-key.pem"),
    "-CAcreateserial",
    "-out",
    path("server.pem"),
    "-days",
    "30",
    "-sha256",
    "-extfile",
    path("server.ext"),
  ]);
  for (const name of [
    "ca-key.pem",
    "ca.pem",
    "server-key.pem",
    "server.pem",
    "server.csr",
    "ca.srl",
  ])
    await chmod(path(name), 0o600);
}

async function simulator(lab) {
  const devices = JSON.parse(await simctl("list", "devices", "--json"));
  const previous = await lab.read("simulator.json");
  let current =
    previous &&
    Object.values(devices.devices)
      .flat()
      .find((item) => item.udid === previous.udid);
  if (current && (current.name !== "Hikaro Mobile Lab" || !current.isAvailable))
    throw Error(
      "Managed test simulator changed or is unavailable; inspect simulator.json",
    );
  if (!current) {
    const runtimes = JSON.parse(await simctl("list", "runtimes", "--json"));
    const runtime = runtimes.runtimes
      .filter((item) => item.isAvailable && item.platform === "iOS")
      .sort((a, b) =>
        b.version.localeCompare(a.version, undefined, { numeric: true }),
      )[0];
    if (!runtime)
      throw Error("Install an iOS simulator runtime in Xcode first");
    const udid = (
      await simctl(
        "create",
        "Hikaro Mobile Lab",
        "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
        runtime.identifier,
      )
    ).trim();
    await lab.write("simulator.json", { udid });
    current = { udid, state: "Shutdown" };
  }
  if (current.state === "Shutdown") await simctl("boot", current.udid);
  await simctl("bootstatus", current.udid, "-b");
  await simctl(
    "keychain",
    current.udid,
    "add-root-cert",
    join(lab.directory, "ca.pem"),
  );
  return current.udid;
}

async function install(lab, udid) {
  const hash = createHash("sha256");
  for (const file of [
    "apps/mobile/app.json",
    "apps/mobile/package.json",
    "apps/mobile/assets/icon.png",
    "pnpm-lock.yaml",
  ])
    hash.update(await readFile(join(ROOT, file)));
  const fingerprint = hash.digest("hex");
  const previous = await lab.read("native.json");
  const binaryDir = join(lab.directory, "native-build");
  let binary = join(binaryDir, "hikaro.app");
  const installed = await simctl(
    "get_app_container",
    udid,
    "dev.hikaro.mobile",
    "app",
  ).then(
    () => true,
    () => false,
  );
  if (
    process.argv.includes("--build") ||
    previous?.fingerprint !== fingerprint ||
    !installed
  ) {
    if (
      process.argv.includes("--build") ||
      previous?.fingerprint !== fingerprint ||
      !(await exists(binary))
    ) {
      console.log(
        "首次或原生配置变更：构建独立开发客户端。此步骤不打开 DeviceHub。",
      );
      await foreground("pnpm", [
        "--filter",
        "@hikaro/mobile",
        "exec",
        "expo",
        "prebuild",
        "--platform",
        "ios",
        "--no-install",
      ]);
      await foreground("pnpm", [
        "--filter",
        "@hikaro/mobile",
        "exec",
        "expo",
        "run:ios",
        "--device",
        "generic",
        "--no-bundler",
        "--output",
        binaryDir,
      ]);
    }
    await simctl("install", udid, binary);
    await lab.write("native.json", { fingerprint });
  }
}

export async function switchPreview(
  udid,
  io = {
    run,
    readdir,
    readFile,
    kill: process.kill,
    pause: () => new Promise((done) => setTimeout(done, 100)),
  },
) {
  const { run, readdir, readFile, kill, pause } = io;
  // Switch only this repository's known serve-sim process; never Kaku/unknown services.
  const pids = await run("lsof", ["-t", "-iTCP:3200", "-sTCP:LISTEN"]).catch(
    () => "",
  );
  if (!pids.trim()) return;
  const entries = await readdir(join(tmpdir(), "serve-sim"));
  for (const name of entries.filter((name) =>
    /^server-[A-Fa-f0-9-]+\.json$/.test(name),
  )) {
    const state = JSON.parse(
      await readFile(join(tmpdir(), "serve-sim", name), "utf8"),
    );
    if (
      state.port !== 3200 ||
      !Number.isSafeInteger(state.pid) ||
      !pids.trim().split(/\s+/).includes(String(state.pid))
    )
      continue;
    const command = await run("ps", [
      "-p",
      String(state.pid),
      "-o",
      "command=",
    ]);
    const cwd = await run("lsof", [
      "-a",
      "-p",
      String(state.pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    if (
      !command.includes("serve-sim") ||
      !command.includes(state.device) ||
      !cwd.split("\n").includes("n" + ROOT.replace(/\/$/, ""))
    )
      break;
    if (state.device === udid) return;
    console.log("切换本项目的预览到专用测试模拟器。");
    kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        !(
          await run("lsof", ["-t", "-iTCP:3200", "-sTCP:LISTEN"]).catch(
            () => "",
          )
        ).trim()
      )
        return;
      await pause();
    }
    throw Error("Previous preview did not exit");
  }
  throw Error(
    "3200 belongs to another project or unknown service; stop it before starting the lab",
  );
}

async function main() {
  if (process.platform !== "darwin")
    throw Error(
      "mobile:lab requires macOS and Xcode; use mobile:lab:check for headless checks",
    );
  process.umask(0o077);
  const artifacts = join(ROOT, "artifacts");
  await mkdir(artifacts, { recursive: true });
  if ((await lstat(artifacts)).isSymbolicLink())
    throw Error("Lab artifacts directory cannot be a symbolic link");
  const lab = await openLab(join(artifacts, "mobile-lab"));
  const release = await lockLab(lab);
  try {
    await certificates(lab);
    const udid = await simulator(lab);
    await install(lab, udid);
    await switchPreview(udid);
    const env = {
      ...process.env,
      HIKARO_SIM_DEVICE: udid,
      HIKARO_MOBILE_LAB_DEVICE: udid,
      HIKARO_MOBILE_FIXTURE_DIR: lab.directory,
      NODE_EXTRA_CA_CERTS: join(lab.directory, "ca.pem"),
    };
    await foreground("pnpm", ["dev:sim"], env);
    console.log(
      "浏览器打开 http://localhost:3200/；如果已经开着，请刷新。无需打开 DeviceHub。\n接下来在本终端输入命令测试配对、授权和恢复。",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/mobile-fixture.mjs"],
      { cwd: ROOT, env, stdio: "inherit" },
    );
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const [code] = await once(child, "exit");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (code) throw Error(`Mobile lab exited (${code})`);
  } finally {
    await release();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
