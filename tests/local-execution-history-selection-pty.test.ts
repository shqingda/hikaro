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

it.each(["direct", "manager", "during-switch"] as const)(
  "isolates late history from the foreground session across a session switch (%s)",
  async (mode) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-history-selection-")),
    );
    const cwd = join(home, "workspace"),
      log = join(home, "observations.txt");
    await mkdir(cwd);
    await writeFile(log, "");
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    const model = { provider: "demo", model: "offline", settings: {} };
    const old = await store.createSession(cwd, "Old session", undefined, model);
    const next = await store.createSession(
      cwd,
      "New session",
      undefined,
      model,
    );
    for (const [session, runId] of [
      [old, "OLD-SESSION-HISTORY"],
      [next, "NEW-SESSION-HISTORY"],
    ] as const) {
      await store.append(session.id, "run.start", {
        runId,
        provider: "fixture",
        model: "history",
      });
      await store.append(session.id, "run.end", { runId, status: "completed" });
    }
    await store.close();
    const probe = join(home, "delay-and-observe.mjs");
    // Delay real storage calls with explicit gates. No query, panel, or session
    // result is replaced: the CLI still executes the ordinary production flow.
    await writeFile(
      probe,
      `
import { appendFileSync, existsSync } from "node:fs";
import { Runtime } from ${JSON.stringify(pathToFileURL(resolve("packages/runtime/src/index.ts")).href)};
import { SQLiteStore } from ${JSON.stringify(pathToFileURL(resolve("packages/storage/src/index.ts")).href)};
import { ModelPanel } from ${JSON.stringify(pathToFileURL(resolve("packages/tui/src/model-panel.ts")).href)};
import { LocalQuestions } from ${JSON.stringify(pathToFileURL(resolve("packages/cli/src/local-questions.ts")).href)};
const note = (text) => appendFileSync(${JSON.stringify(log)}, text + "\\n");
const gate = async (name) => { while (!existsSync(${JSON.stringify(home)} + "/release-" + name)) await new Promise(r => setTimeout(r, 10)); };
const session = Runtime.prototype.session;
Runtime.prototype.session = async function (id, ...args) {
  if (id === ${JSON.stringify(next.id)}) { note("resume-started"); await gate("resume"); }
  return session.call(this, id, ...args);
};
const remember = SQLiteStore.prototype.rememberSession;
SQLiteStore.prototype.rememberSession = async function (id) {
  if (id === ${JSON.stringify(next.id)}) { note("bind-started"); await gate("bind"); }
  const result = await remember.call(this, id);
  if (id === ${JSON.stringify(next.id)}) note("bind-finished");
  return result;
};
const select = LocalQuestions.prototype.select;
LocalQuestions.prototype.select = async function (id) {
  const result = await select.call(this, id);
  if (id === ${JSON.stringify(next.id)}) setTimeout(() => note("selection-ready"), 10);
  return result;
};
for (const method of ["runHistoryPage", "runHistoryDetail"]) {
  const original = SQLiteStore.prototype[method];
  SQLiteStore.prototype[method] = async function (id, ...args) {
    if (id === ${JSON.stringify(old.id)}) { note("old-history-started"); await gate("history"); }
    const result = await original.call(this, id, ...args);
    if (id === ${JSON.stringify(old.id)}) setTimeout(() => note("old-history-settled"), 20);
    return result;
  };
}
for (const method of ["choose", "readDocument"]) {
  const original = ModelPanel.prototype[method];
  ModelPanel.prototype[method] = function (...args) { note("panel:" + JSON.stringify(args)); return original.apply(this, args); };
}
`,
    );
    let output = "";
    const terminal = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        probe,
        resolve("packages/cli/src/index.ts"),
        "--home",
        home,
        "--cwd",
        cwd,
        "--session",
        old.id,
        "--demo",
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
    const exited = new Promise<number>((done) =>
      terminal.onExit(({ exitCode }) => done(exitCode)),
    );
    const send = (text: string) => {
      const offset = output.length;
      terminal.write(text);
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
    const observed = (text: string) =>
      vi.waitFor(
        async () => expect(await readFile(log, "utf8")).toContain(text),
        { timeout: 10000 },
      );
    const release = (name: string) =>
      writeFile(join(home, `release-${name}`), "");
    try {
      await wait("Enter send");
      send(`/resume ${next.id}\r`);
      await observed("resume-started");
      if (mode === "during-switch") {
        await release("resume");
        await observed("bind-started");
        // The new layout is already selected while remembering selection waits.
        // An old run ID must be rejected by the new session, never cross-read.
        const attempt = send("/tasks history OLD-SESSION-HISTORY\r");
        await wait("Recorded run not found in this session", attempt);
        expect(await readFile(log, "utf8")).not.toContain(
          "old-history-started",
        );
      } else {
        if (mode === "direct") send("/tasks history OLD-SESSION-HISTORY\r");
        else {
          send("/tasks\r");
        }
        await observed("old-history-started");
        await release("resume");
        await observed("bind-started");
      }
      await release("bind");
      await observed("bind-finished");
      await observed("selection-ready");
      const db = new DatabaseSync(join(home, "sessions.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare("SELECT sessionId FROM workspace_state WHERE cwd=?")
            .get(cwd)?.sessionId,
        ).toBe(next.id);
      } finally {
        db.close();
      }
      const lateOffset = output.length;
      await release("history");
      if (mode !== "during-switch") await observed("old-history-settled");
      expect(stripVTControlCharacters(output.slice(lateOffset))).not.toContain(
        "OLD-SESSION-HISTORY",
      );
      // A late response cannot leave the old panel open or prevent reading the
      // newly selected task after the transition has finished.
      await wait(
        "Run: NEW-SESSION-HISTORY",
        send("/tasks history NEW-SESSION-HISTORY\r"),
      );
      await wait("Execution history · page 1", send("\x1b"));
      await wait("Enter send", send("\x1b"));
      send("\x04");
      expect(await exited).toBe(0);
    } finally {
      await Promise.all([
        release("resume"),
        release("bind"),
        release("history"),
      ]);
      terminal.kill();
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
