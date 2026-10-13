import { it, expect } from "vitest";
import { spawn } from "node-pty";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
it("enters fullscreen, handles Unicode and restores terminal on exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-pty-"));
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("apps/cli/src/index.ts"),
          "--demo",
          "--home",
          home,
        ],
        { cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" } },
      );
      let output = "";
      let phase = 0;
      const timeout = setTimeout(() => {
        child.kill();
        reject(Error("PTY timeout"));
      }, 10000);
      child.onData((data) => {
        output += data;
        if (phase === 0 && output.includes("/help")) {
          phase = 1;
          child.write("你好 👋\r");
        }
        if (phase === 1 && output.includes("You wrote:")) {
          phase = 2;
          child.resize(60, 18);
          child.write("\x04");
        }
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        try {
          expect(exitCode).toBe(0);
          expect(output).toContain("\x1b[?1049h");
          expect(output).toContain("\x1b[?1049l");
          expect(output).toContain("你好");
          done();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
