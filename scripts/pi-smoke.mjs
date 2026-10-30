import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node-pty";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

const temporary = await mkdtemp(join(tmpdir(), "hikaro-pi-"));
const home = join(temporary, "hikaro");
const cwd = join(temporary, "workspace");
const command = process.env.HIKARO_PI_COMMAND ?? "pi";
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: join(temporary, "pi"),
  HIKARO_DEMO: "1",
  TERM: "xterm-256color",
};
// The installed entry must retain --home even without an ambient HIKARO_HOME.
delete env.HIKARO_HOME;
try {
  await mkdir(cwd);
  const execute = promisify(execFile);
  const installArgs = [
    resolve(process.env.HIKARO_PI_ENTRY ?? "dist/hikaro.mjs"),
    "--install-pi",
    "--pi-command",
    command,
    "--home",
    home,
  ];
  await execute(process.execPath, installArgs, { cwd, env, timeout: 30_000 });
  // Reinstall is the supported upgrade path, keeping the same registered entry.
  await execute(process.execPath, installArgs, { cwd, env, timeout: 30_000 });
  const settings = JSON.parse(
    await readFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
  );
  assert.equal(
    settings.packages.filter(
      (source) =>
        typeof source === "string" &&
        resolve(env.PI_CODING_AGENT_DIR, source) ===
          join(home, "pi-extension.mjs"),
    ).length,
    1,
  );
  await new Promise((done, reject) => {
    const terminal = spawn(
      command,
      [
        "--offline",
        "--no-session",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
      ],
      { cwd, cols: 100, rows: 32, env },
    );
    let output = "",
      phase = 0;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(Error("Installed Pi bridge timeout: " + output.slice(-2500)));
    }, 15_000);
    terminal.onData((data) => {
      output = (output + stripVTControlCharacters(data)).slice(-30000);
      if (
        phase === 0 &&
        output.includes("/back returns to Pi") &&
        output.includes("Ready · Permissions: Hikaro")
      ) {
        phase = 1;
        terminal.write("bridge smoke\r");
      }
      if (phase === 1 && output.includes("offline demo mode")) {
        phase = 2;
        output = "";
        terminal.write("/back\r");
        setTimeout(() => terminal.write("/hikaro default off\r"), 150);
      }
      if (phase === 2 && output.includes("Hikaro default off")) {
        phase = 3;
        terminal.write("\x04");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (phase === 3 && exitCode === 0) done();
      else
        reject(
          Error(
            `Pi exited (${exitCode}, phase ${phase}): ${output.slice(-2000)}`,
          ),
        );
    });
  });
  assert.equal(
    JSON.parse(await readFile(join(home, "pi-bridge.json"), "utf8")).autoOpen,
    false,
  );
  console.log(
    "Pi 1.4 smoke passed: persistent install/reinstall, custom home auto-entry, offline response, /back and native command, clean exit.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
