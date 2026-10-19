import { execFile, spawn } from "node:child_process";
import { readFile, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const DEVICE =
  process.env.HIKARO_SIM_DEVICE ?? "498E27B7-5192-48CE-9B13-F4A27F10F806";
const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const PREVIEW = "http://127.0.0.1:3200";
const METRO = "http://127.0.0.1:8081";
const INPUT = "com.apple.coredevice.dtuhidd.active";
const LOG_DIR = join(tmpdir(), "hikaro-dev-sim");

// Keep orchestration testable without touching the owner's simulator or processes.
export async function launchSimulator(io) {
  const simctl = (...args) => io.run("xcrun", ["simctl", ...args]);
  async function waitFor(label, check, attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await check()) return;
      await io.pause();
    }
    throw new Error(`${label}超时；查看 ${LOG_DIR} 下的日志。`);
  }

  const devices = JSON.parse(await simctl("list", "devices", "--json"));
  const device = Object.values(devices.devices)
    .flat()
    .find((item) => item.udid === DEVICE);
  if (!device?.isAvailable)
    throw new Error(
      `指定模拟器不存在或不可用：${DEVICE}；不会新建或克隆设备。`,
    );
  if (device.state === "Shutdown") await simctl("boot", DEVICE);
  if (device.state !== "Booted") await simctl("bootstatus", DEVICE);
  await simctl("get_app_container", DEVICE, "dev.hikaro.mobile", "app");

  const metroStatus = await io.fetchText(`${METRO}/status`);
  if (metroStatus === "packager-status:running") {
    const pids = (await io.run("lsof", ["-t", "-iTCP:8081", "-sTCP:LISTEN"]))
      .trim()
      .split("\n");
    if (!pids.length || !pids.every((pid) => /^\d+$/.test(pid)))
      throw new Error("无法确认 8081 的 Metro 进程。");
    const owner = await io.run("lsof", [
      "-a",
      "-p",
      pids.join(","),
      "-d",
      "cwd",
      "-Fn",
    ]);
    if (
      !owner
        .split("\n")
        .some((line) => line === `n${ROOT}/apps/mobile` || line === `n${ROOT}`)
    ) {
      throw new Error(
        "8081 上的 Metro 不属于当前项目；请先停止其他项目的 Metro。",
      );
    }
    io.log("复用 Hikaro Metro。");
  } else {
    if (
      metroStatus !== null ||
      (await io.run("lsof", ["-t", "-iTCP:8081", "-sTCP:LISTEN"], true))
    )
      throw new Error("8081 已被占用或只监听 IPv6；请先检查现有开发服务。");
    io.start(
      "pnpm",
      ["dev:mobile", "--dev-client", "--host", "lan", "--port", "8081"],
      "metro",
    );
    await waitFor(
      "Metro 启动",
      async () =>
        (await io.fetchText(`${METRO}/status`)) === "packager-status:running",
    );
  }

  const inputState = (
    await simctl("spawn", DEVICE, "notifyutil", "-g", INPUT)
  ).trim();
  if (inputState !== `${INPUT} 0` && inputState !== `${INPUT} 1`)
    throw new Error(`无法识别模拟器输入状态：${inputState}`);
  const shadowed = inputState === `${INPUT} 1`;
  if (shadowed) {
    io.log("DeviceHub 接管了输入，正在恢复；App 将短暂关闭，数据保留。");
    await io.run("pnpm", ["exec", "serve-sim", "repair-input", "-d", DEVICE]);
    // repair-input returns before backboardd/SpringBoard have finished restarting.
    let springBoard = "";
    let stableChecks = 0;
    await waitFor("SpringBoard 恢复", async () => {
      const processes = await io.run(
        "xcrun",
        ["simctl", "spawn", DEVICE, "launchctl", "list"],
        true,
      );
      const running = processes
        ?.split("\n")
        .find(
          (line) =>
            /^\d+\s/.test(line) &&
            line.trim().endsWith("com.apple.SpringBoard"),
        );
      stableChecks = running && running === springBoard ? stableChecks + 1 : 0;
      springBoard = running ?? "";
      return stableChecks >= 2;
    });
  }

  const state = await io.readPreview();
  let previewPage = await io.fetchText(PREVIEW);
  if (previewPage !== null) {
    const command =
      state &&
      (await io.run("ps", ["-p", String(state.pid), "-o", "command="], true));
    if (
      state?.device !== DEVICE ||
      state?.port !== 3200 ||
      !Number.isSafeInteger(state?.pid) ||
      !command?.includes("serve-sim") ||
      !command.includes(DEVICE) ||
      !previewPage.includes("<title>Simulator")
    ) {
      throw new Error("3200 已被其他预览或服务占用；不会停止未知进程。");
    }
    if (shadowed) {
      await io.run("kill", ["-TERM", String(state.pid)]);
      await waitFor(
        "旧预览退出",
        async () => (await io.fetchText(PREVIEW)) === null,
      );
      previewPage = null;
    } else io.log("复用指定设备的 serve-sim 预览。");
  }
  if (previewPage === null) {
    io.start(
      "pnpm",
      ["exec", "serve-sim", DEVICE, "--port", "3200", "--host", "127.0.0.1"],
      "preview",
    );
    await waitFor("模拟器预览启动", async () =>
      (await io.fetchText(PREVIEW))?.includes("<title>Simulator"),
    );
  }
  if (!process.argv.includes("--no-launch"))
    await simctl(
      "openurl",
      DEVICE,
      `hikaro-companion://expo-development-client/?url=${encodeURIComponent(METRO)}`,
    );
  await io.run("open", ["http://localhost:3200/"]);
  io.log(
    `已复用 iPhone 模拟器并打开：http://localhost:3200/\n服务在后台运行，无需 DeviceHub 窗口。日志：${LOG_DIR}`,
  );
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("dev:sim 需要安装 Xcode 的 macOS。");
  const exec = promisify(execFile);
  await mkdir(LOG_DIR, { recursive: true });
  const logs = {};
  for (const name of ["metro", "preview"])
    logs[name] = await open(join(LOG_DIR, `${name}.log`), "a");
  try {
    await launchSimulator({
      log: console.log,
      pause: () => new Promise((done) => setTimeout(done, 1000)),
      async run(command, args, allowFailure = false) {
        try {
          return (
            await exec(command, args, {
              cwd: ROOT,
              timeout: command === "xcrun" ? 120000 : 30000,
            })
          ).stdout;
        } catch (error) {
          if (allowFailure) return null;
          throw new Error(
            `${command} ${args.join(" ")} 失败：${error.stderr || error.message}`,
          );
        }
      },
      start(command, args, name) {
        const child = spawn(command, args, {
          cwd: ROOT,
          env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1" },
          detached: true,
          stdio: ["ignore", logs[name].fd, logs[name].fd],
        });
        child.on("error", (error) =>
          console.error(`${name} 启动失败：${error.message}`),
        );
        child.unref();
      },
      async fetchText(url) {
        // curl bypasses Clash and preserves localhost access regardless of proxy env.
        try {
          return (
            await exec("curl", [
              "--noproxy",
              "*",
              "-fsS",
              "--max-time",
              "2",
              url,
            ])
          ).stdout;
        } catch {
          return null;
        }
      },
      async readPreview() {
        try {
          return JSON.parse(
            await readFile(
              join(tmpdir(), "serve-sim", `server-${DEVICE}.json`),
              "utf8",
            ),
          );
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      },
    });
  } finally {
    await Promise.all(Object.values(logs).map((file) => file.close()));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
