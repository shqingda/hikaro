import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { defaultTuiPreferences } from "../packages/tui/src/preferences.ts";

it.each([false, true])(
  "reads complete tool output in TUI (attached=%s)",
  async (attached) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-tool-output-pty-")),
    );
    const cwd = join(home, "workspace");
    await mkdir(cwd);
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    let host: ReturnType<typeof spawnProcess> | undefined;
    let hostExit: Promise<unknown> | undefined;
    let terminal: ReturnType<typeof spawn> | undefined;
    let terminalExit: Promise<number> | undefined;
    const args = [
      resolve(process.env.HIKARO_TEST_BIN ?? "dist/hikaro.mjs"),
      "--home",
      home,
      "--cwd",
      cwd,
    ];
    try {
      const session = await store.createSession(
        cwd,
        "Tool output fixture",
        undefined,
        {
          provider: "demo",
          model: "offline",
          settings: {},
        },
      );
      await writeFile(
        join(home, "tui-preferences.json"),
        JSON.stringify({
          ...defaultTuiPreferences,
          showToolDetails: true,
        }),
      );
      await store.append(session.id, "message", {
        message: {
          role: "tool",
          name: "shell",
          isError: true,
          text:
            "**literal output**\n" +
            "tool output row\n".repeat(1500) +
            "\n[Output truncated; complete result: /tmp/complete-tool-output.json]",
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
      if (attached) {
        await wait("/help");
        await wait("Tool details enabled", send("/tools\r"));
        send("/latest\r");
      }
      await wait("Message 1 · part 1/2 · /read 1 PART");
      await wait(
        "complete result: /tmp/complete-tool-output.json",
        send("/read 1 2\r"),
      );
      await wait("Message 1 · part 2/2");
      await wait("Message 1 · part 1/2", send("/read 1 1\r"));
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
