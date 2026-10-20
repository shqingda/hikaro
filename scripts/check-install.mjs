import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "hikaro-install-"));
const checkout = join(temporary, "source");
try {
  // Copy only tracked source: never reuse node_modules, dist, credentials or
  // generated native helpers from the developer's checkout.
  const { stdout } = await exec("git", ["ls-files", "-z"], { cwd: root });
  for (const file of stdout.split("\0").filter(Boolean)) {
    const target = join(checkout, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  for (const args of [
    ["install", "--frozen-lockfile", "--filter", "hikaro"],
    ["typecheck"],
    ["build"],
  ]) {
    console.log(`Clean source: pnpm ${args.join(" ")}`);
    try {
      const result = await exec("pnpm", args, {
        cwd: checkout,
        timeout: 240000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: "true" },
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    } catch (error) {
      process.stderr.write(error.stdout ?? "");
      process.stderr.write(error.stderr ?? "");
      throw error;
    }
  }
  const require = createRequire(join(checkout, "package.json"));
  const { spawn } = require("node-pty");
  const terminal = spawn(
    process.execPath,
    [
      join(checkout, "dist/hikaro.mjs"),
      "--demo",
      "--new",
      "--home",
      join(temporary, "home"),
      "--cwd",
      checkout,
    ],
    {
      cwd: checkout,
      cols: 100,
      rows: 30,
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );
  await new Promise((done, reject) => {
    let output = "",
      ready = false;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(
        Error(
          `Clean installation did not start and exit within 15s: ${stripVTControlCharacters(output).slice(-3000)}`,
        ),
      );
    }, 15000);
    terminal.onData((data) => {
      output = (output + data).slice(-16000);
      if (!ready && stripVTControlCharacters(output).includes("/help")) {
        ready = true;
        terminal.write("\x04");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (ready && exitCode === 0) done();
      else
        reject(
          Error(
            `Clean TUI exited ${exitCode}, ready=${ready}: ${stripVTControlCharacters(output).slice(-3000)}`,
          ),
        );
    });
  });
  console.log(
    "PASS: isolated source install, typecheck, native build, built TUI startup and clean exit",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
