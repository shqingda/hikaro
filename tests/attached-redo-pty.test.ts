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
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { ChangeJournal } from "../packages/tools/src/changes.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it("confirms and cancels redo through built attached TUI and preserves later edits", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-attached-redo-")),
  );
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  let host: ReturnType<typeof spawnProcess> | undefined;
  let hostExit: Promise<unknown> | undefined;
  let terminal: ReturnType<typeof spawn> | undefined;
  let terminalExit: Promise<number> | undefined;
  let client: SharedHostClient | undefined;
  try {
    const session = await store.createSession(cwd, "Redo", undefined, {
      provider: "demo",
      model: "offline",
      settings: {},
    });
    const path = join(cwd, "redo.txt");
    const journal = new ChangeJournal(home);
    const signal = new AbortController().signal;
    await writeFile(path, "before");
    await journal.update(session.id, path, signal, () => "after 中文");
    const [entry] = await journal.list(session.id);
    await journal.rollback(session.id, entry!.id, signal);
    const args = [resolve("dist/hikaro.mjs"), "--home", home, "--cwd", cwd];
    host = spawnProcess(process.execPath, [...args, "--host", "--demo"]);
    hostExit = new Promise((done) => host!.once("exit", done));
    let hostOutput = "";
    host.stdout!.on("data", (data) => (hostOutput += data));
    host.stderr!.on("data", (data) => (hostOutput += data));
    await vi.waitFor(() => expect(hostOutput).toContain("shared host ready"), {
      timeout: 10000,
    });
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "redo-observer",
    });
    const hello = (await client.request("hello")) as { methods: string[] };
    expect(hello.methods).toContain("changes.redo");
    await client.request("session.resume", { sessionId: session.id });
    terminal = spawn(
      process.execPath,
      [...args, "--attach", "--session", session.id],
      {
        cols: 110,
        rows: 38,
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    terminalExit = new Promise((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
    let output = "";
    terminal.onData((data) => (output += data));
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
        { timeout: 8000 },
      );
    await wait("/help");
    await wait("File changes", send("/changes\r"));
    await wait("Reapply this edit", send("\r"));
    await wait("Confirm reapply edit", send("\x1b[B\r"));
    await wait("File changes", send("\x1b"));
    expect(await readFile(path, "utf8")).toBe("before");
    await wait("Reapply this edit", send("\r"));
    await wait("Confirm reapply edit", send("\x1b[B\r"));
    const applied = send("\x1b[B\r");
    await wait("Reapplied redo.txt", applied);
    await wait("Edited · committed", applied);
    expect(await readFile(path, "utf8")).toBe("after 中文");
    await wait("Enter send", send("\x1b"));
    const newEntry = (await journal.list(session.id)).find(
      (e) => e.id !== entry!.id,
    )!;
    await client.request("changes.rollback", {
      sessionId: session.id,
      id: newEntry.id,
    });
    await writeFile(path, "later work");
    await expect(
      client.request("changes.redo", { sessionId: session.id, id: entry!.id }),
    ).rejects.toThrow(/Preserve/);
    expect(await readFile(path, "utf8")).toBe("later work");
    send("\x04");
    expect(await terminalExit).toBe(0);
  } finally {
    terminal?.kill();
    await terminalExit;
    await client?.close();
    host?.kill("SIGTERM");
    await hostExit;
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}, 35000);
