import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { Planning } from "../packages/runtime/src/planning.ts";

it.each([false, true])(
  "browses saved plan history without execution in TUI (attached=%s)",
  async (attached) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-plan-history-pty-")),
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
        "Plan history fixture",
        undefined,
        {
          provider: "demo",
          model: "offline",
          settings: {},
        },
      );
      const planning = new Planning(home);
      await planning.load(session.id);
      await planning.setActive(session.id, true);
      for (let revision = 1; revision <= 23; revision++)
        await planning.propose(session.id, {
          title: `Saved plan ${revision}`,
          steps: [`UNIQUE-STEP-${revision}-END`],
          validation: `VALIDATION-${revision}-END`,
        });
      await planning.setActive(session.id, false);
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
      await wait("Enter send");
      await wait("Plan history · page 1", send("/plan history\r"));
      await wait("Plan version 23 · read-only", send("\r"));
      await wait("UNIQUE-STEP-23-END");
      await wait("VALIDATION-23-END");
      await wait("Plan history · page 1", send("\x1b"));
      await wait("→ Close history", send("\x1b[A"));
      await wait("→ Older versions", send("\x1b[A"));
      await wait("Plan history · page 2", send("\r"));
      await wait("→ Version 2", send("\x1b[B"));
      await wait("→ Version 1", send("\x1b[B"));
      await wait("Plan version 1 · read-only", send("\r"));
      await wait("UNIQUE-STEP-1-END");
      await wait("VALIDATION-1-END");
      await wait("Plan history · page 2", send("\x1b"));
      await wait("Enter send", send("\x1b"));
      send("\x04");
      expect(await terminalExit).toBe(0);
      await planning.load(session.id, true);
      expect(planning.get(session.id)).toEqual({ active: false });
      expect(
        (await store.events(session.id)).filter(
          (event) => event.type === "run.start",
        ),
      ).toEqual([]);
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
