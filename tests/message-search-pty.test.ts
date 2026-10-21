import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it.each([false, true])(
  "searches and reads full messages in TUI (attached=%s)",
  async (attached) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-search-pty-")),
    );
    const cwd = join(home, "workspace");
    await mkdir(cwd);
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    let host: ReturnType<typeof spawnProcess> | undefined;
    let hostExit: Promise<unknown> | undefined;
    let terminal: ReturnType<typeof spawn> | undefined;
    let terminalExit: Promise<number> | undefined;
    const args = [resolve("dist/hikaro.mjs"), "--home", home, "--cwd", cwd];
    try {
      const session = await store.createSession(
        cwd,
        "Search fixture",
        undefined,
        {
          provider: "demo",
          model: "offline",
          settings: {},
        },
      );
      await store.append(session.id, "message", {
        message: {
          role: "user",
          text:
            "ORIGINAL-BEGIN\n" +
            "ordinary line\n".repeat(1700) +
            "FULLTEXT-NEEDLE",
          timestamp: 1,
        },
      });
      if (attached) {
        host = spawnProcess(process.execPath, [...args, "--host", "--demo"]);
        hostExit = new Promise((done) => host!.once("exit", done));
        let output = "";
        host.stdout!.on("data", (data) => (output += data));
        host.stderr!.on("data", (data) => (output += data));
        await vi.waitFor(() => expect(output).toContain("shared host ready"), {
          timeout: 10000,
        });
      }
      let output = "";
      terminal = spawn(
        process.execPath,
        [
          ...args,
          "--session",
          session.id,
          ...(attached ? ["--attach"] : ["--demo"]),
        ],
        {
          cols: 110,
          rows: 38,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      terminal.onData((data) => (output += data));
      terminalExit = new Promise((done) =>
        terminal!.onExit(({ exitCode }) => done(exitCode)),
      );
      const wait = (text: string, offset = 0) =>
        vi.waitFor(
          () =>
            expect(stripVTControlCharacters(output.slice(offset))).toContain(
              text,
            ),
          { timeout: 10000 },
        );
      const send = (text: string) => {
        const offset = output.length;
        terminal!.write(text);
        return offset;
      };
      await wait("/help");
      await wait("Search: FULLTEXT-NEEDLE", send("/search FULLTEXT-NEEDLE\r"));
      await wait("FULLTEXT-NEEDLE");
      await wait("ORIGINAL-BEGIN", send("\r"));
      await wait("Next section");
      await wait("section 2", send("\x1b[B\r"));
      await wait("FULLTEXT-NEEDLE", send("\x1b[F"));
      await wait("Search: FULLTEXT-NEEDLE", send("\x1b"));
      await wait("Enter send", send("\x1b"));
      send("\x04");
      expect(await terminalExit).toBe(0);
    } finally {
      terminal?.kill();
      await terminalExit;
      host?.kill("SIGTERM");
      await hostExit;
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  35000,
);
