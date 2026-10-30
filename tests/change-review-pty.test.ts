import { expect, it } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("reviews a real model file edit, cancels confirmation, then rolls it back from the TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-review-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const original = Array.from(
    { length: 40 },
    (_, i) => `original line ${i}`,
  ).join("\n");
  const modified = Array.from(
    { length: 40 },
    (_, i) => `modified line ${i}`,
  ).join("\n");
  await writeFile(join(cwd, "sample.txt"), original);
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain request */
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "review-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (++requestCount === 1) {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "edit-fixture",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({
                path: "sample.txt",
                oldText: original,
                newText: modified,
              }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "Review fixture completed." });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const terminal = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("packages/cli/src/index.ts"),
      "--new",
      "--provider",
      "local",
      "--model",
      "fixture",
      "--base-url",
      `http://127.0.0.1:${port}/v1`,
      "--home",
      home,
      "--cwd",
      cwd,
    ],
    {
      cwd: process.cwd(),
      cols: 100,
      rows: 36,
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );
  let output = "";
  const watchers = new Set<() => void>();
  const exited = new Promise<number>((done) =>
    terminal.onExit(({ exitCode }) => done(exitCode)),
  );
  terminal.onData((data) => {
    output += data;
    for (const fn of watchers) fn();
  });
  const send = (text: string) => {
    const offset = output.length;
    terminal.write(text);
    return offset;
  };
  const wait = (text: string, offset = 0) =>
    new Promise<void>((done, reject) => {
      const check = () => {
        if (stripVTControlCharacters(output.slice(offset)).includes(text)) {
          clearTimeout(timer);
          watchers.delete(check);
          done();
        }
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(
          Error(
            `Missing ${text}: ${stripVTControlCharacters(output.slice(-6000))}`,
          ),
        );
      }, 8000);
      watchers.add(check);
      check();
    });
  try {
    await wait("/help");
    const submitted = send("Change sample.txt\r");
    await wait("Review fixture completed.", submitted);
    await wait("Enter send", submitted);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(modified);
    await wait("File changes", send("/changes\r"));
    await wait("original line 0", send("\r"));
    await wait("modified line 39", send("\x1b[F"));
    await wait("Confirm file rollback", send("\x1b[B\r"));
    await wait("File changes", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(modified);
    await wait("original line 0", send("\r"));
    await wait("Confirm file rollback", send("\x1b[B\r"));
    const rolledBack = send("\x1b[B\r");
    await wait("Rolled back sample.txt", rolledBack);
    await wait("Edited · reverted", rolledBack);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(original);
    await wait("Reapply this edit", send("\r"));
    await wait("Confirm reapply edit", send("\x1b[B\r"));
    await wait("File changes", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(original);
    await wait("Reapply this edit", send("\r"));
    await wait("Confirm reapply edit", send("\x1b[B\r"));
    const reapplied = send("\x1b[B\r");
    await wait("Reapplied sample.txt", reapplied);
    await wait("Edited · committed", reapplied);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(modified);
    await wait("/help", send("\x1b"));
    send("\x04");
    expect(await exited).toBe(0);
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    try {
      const [session] = await store.sessions();
      expect(
        (await store.messages(session!.id)).some((m) =>
          m.text.includes("File rollback completed"),
        ),
      ).toBe(true);
    } finally {
      await store.close();
    }
  } finally {
    terminal.kill();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
