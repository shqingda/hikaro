import { spawn } from "node-pty";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const temporary = await mkdtemp(join(tmpdir(), "hikaro-pi-"));
try {
  await new Promise((done, reject) => {
    const terminal = spawn(
      "pi",
      [
        "--offline",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "-e",
        resolve("extensions/pi/index.ts"),
      ],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 32,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(temporary, "pi"),
          HIKARO_HOME: join(temporary, "hikaro"),
          HIKARO_DEMO: "1",
          TERM: "xterm-256color",
        },
      },
    );
    let output = "",
      phase = 0;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(Error("Pi bridge timeout: " + output.slice(-2500)));
    }, 15000);
    const enter = setTimeout(() => {
      phase = 1;
      terminal.write("/hikaro\r");
    }, 1200);
    terminal.onData((data) => {
      output = (output + data).slice(-30000);
      if (phase === 1 && output.includes("Hikaro · /back returns to Pi")) {
        phase = 2;
        terminal.write("bridge smoke\r");
      }
      if (phase === 2 && output.includes("offline demo mode")) {
        phase = 3;
        terminal.write("/back\r");
        setTimeout(() => {
          clearTimeout(timeout);
          clearTimeout(enter);
          terminal.kill();
          done();
        }, 300);
      }
    });
    terminal.onExit(({ exitCode }) => {
      if (phase < 3) {
        clearTimeout(timeout);
        clearTimeout(enter);
        reject(Error(`Pi exited (${exitCode}): ${output.slice(-2000)}`));
      }
    });
  });
  console.log(
    "Pi 1.2 smoke passed: dedicated Hikaro view, offline response, return to Pi.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
