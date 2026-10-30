import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it.each([false, true])(
  "pages through more than 200 saved runs and opens an old run by ID after restart (attached=%s)",
  async (attached) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-history-pagination-pty-")),
    );
    const cwd = join(home, "workspace");
    await mkdir(cwd);
    let store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    let host: ReturnType<typeof spawnProcess> | undefined;
    let hostExit: Promise<unknown> | undefined;
    let terminal: ReturnType<typeof spawn> | undefined;
    let terminalExit: Promise<number> | undefined;
    let output = "";
    const observations = join(home, "agent-calls.txt");
    const probe = join(home, "observe-agent.mjs");
    // The probe observes real calls without changing their behavior. A separate
    // Activity and durable history must both remain read-only: neither holds the queue.
    await writeFile(observations, "");
    await writeFile(
      probe,
      `
import { appendFileSync } from "node:fs";
import { Agent } from ${JSON.stringify(pathToFileURL(resolve("packages/core/src/index.ts")).href)};
for (const method of ["holdQueue", "prompt"]) {
  const original = Agent.prototype[method];
  Agent.prototype[method] = function (...args) {
    appendFileSync(${JSON.stringify(observations)}, method + "\\n");
    return Reflect.apply(original, this, args);
  };
}
`,
    );
    const args = [
      "--import",
      "tsx",
      "--import",
      probe,
      resolve("packages/cli/src/index.ts"),
      "--home",
      home,
      "--cwd",
      cwd,
    ];
    const startHost = async () => {
      host = spawnProcess(process.execPath, [...args, "--host", "--demo"]);
      hostExit = new Promise((done) => host!.once("exit", done));
      let hostOutput = "";
      host.stdout!.on("data", (data) => {
        hostOutput += data;
      });
      host.stderr!.on("data", (data) => {
        hostOutput += data;
      });
      await vi.waitFor(
        () => expect(hostOutput).toContain("shared host ready"),
        { timeout: 10000 },
      );
    };
    const stopHost = async () => {
      host?.kill("SIGTERM");
      await hostExit;
      host = undefined;
      hostExit = undefined;
    };
    const startTerminal = (sessionId: string) => {
      output = "";
      terminal = spawn(
        process.execPath,
        [
          ...args,
          "--session",
          sessionId,
          ...(attached
            ? ["--attach", "--client-id", "history-pagination"]
            : ["--demo"]),
        ],
        {
          cols: 110,
          rows: 38,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      terminal.onData((data) => {
        output += data;
      });
      terminalExit = new Promise((done) =>
        terminal!.onExit(({ exitCode }) => done(exitCode)),
      );
    };
    const send = (text: string) => {
      const offset = output.length;
      terminal!.write(text);
      return offset;
    };
    const wait = (text: string, offset = 0) =>
      vi.waitFor(
        () =>
          expect(stripVTControlCharacters(output.slice(offset))).toContain(
            text,
          ),
        { timeout: 10000 },
      );
    const quit = async () => {
      send("\x04");
      expect(await terminalExit).toBe(0);
      terminal = undefined;
      terminalExit = undefined;
    };
    const nextPage = async (page: number) => {
      // New lists start on their first run. The three final actions precede
      // Next page when navigating backward from there.
      await wait("→ Next page", send("\x1b[A".repeat(4)));
      await wait(`Execution history · page ${page}`, send("\r"));
    };
    try {
      const selection = { provider: "demo", model: "offline", settings: {} };
      const session = await store.createSession(
        cwd,
        "Durable history",
        undefined,
        selection,
      );
      const calibration = await store.createSession(
        cwd,
        "Probe calibration",
        undefined,
        selection,
      );
      for (let index = 0; index < 225; index++) {
        const runId =
          index === 0
            ? "old-run-id"
            : `history-run-${String(index).padStart(3, "0")}`;
        await store.append(session.id, "run.start", {
          runId,
          provider: "fixture",
          model: "persisted-history",
        });
        await store.append(session.id, "run.end", {
          runId,
          status: index === 0 ? "failed" : "completed",
          ...(index === 0 ? { error: "OLDEST-HISTORY-DETAIL 中文🌅" } : {}),
          usage: { input: index + 1, output: 2, cost: 0 },
        });
      }
      const eventsBefore = await store.events(session.id, 0, 1000);
      expect(
        eventsBefore.filter((event) => event.type === "run.start"),
      ).toHaveLength(225);
      await store.close();
      store = await SQLiteStore.open(join(home, "sessions.sqlite"));
      if (attached) await startHost();

      startTerminal(calibration.id);
      await wait("Enter send");
      await wait("Activity", send("/tasks\r"));
      expect(await readFile(observations, "utf8")).toBe("");
      // Closing the process from a read-only page must not create execution state.
      await quit();
      await writeFile(observations, "");

      const unchanged = async () => {
        expect(await readFile(observations, "utf8")).toBe("");
        expect(await store.events(session.id, 0, 1000)).toEqual(eventsBefore);
        const database = new DatabaseSync(join(home, "sessions.sqlite"), {
          readOnly: true,
        });
        try {
          expect(
            database
              .prepare(
                "SELECT method FROM rpc_commands WHERE sessionId=? AND method IN ('prompt','execution.hold')",
              )
              .all(session.id),
          ).toEqual([]);
        } finally {
          database.close();
        }
      };
      startTerminal(session.id);
      await wait("Enter send");
      await wait("Execution history · page 1", send("/tasks history\r"));
      for (let page = 2; page <= 12; page++) await nextPage(page);
      await wait("old-run-id", send("\x1b[B".repeat(4)));
      const oldest = send("\r");
      await wait("Execution history · failed", oldest);
      await wait("Run: old-run-id", oldest);
      await wait("OLDEST-HISTORY-DETAIL 中文🌅", oldest);
      await wait("fixture/persisted-history", oldest);
      await wait("Execution history · page 12", send("\x1b"));
      await wait("Enter send", send("\x1b"));
      await unchanged();
      await quit();
      if (attached) {
        await stopHost();
        await startHost();
      }

      startTerminal(session.id);
      await wait("Enter send");
      const exact = send("/tasks history old-run-id\r");
      await wait("Execution history · failed", exact);
      await wait("Run: old-run-id", exact);
      await wait("OLDEST-HISTORY-DETAIL 中文🌅", exact);
      await wait("Execution history · page 1", send("\x1b"));
      await wait("→ Close history", send("\x1b[A"));
      await wait("Enter send", send("\r"));
      await unchanged();
      await quit();
    } finally {
      terminal?.kill();
      await terminalExit;
      await stopHost();
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
