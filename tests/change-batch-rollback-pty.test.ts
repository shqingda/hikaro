import { expect, it } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import {
  access,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

it("rolls back several model edits to a chosen point from the TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-batch-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "sample.txt"), "original");
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain request */
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "batch-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    const tool = (name: string, args: object) => {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${requestCount}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      chunk({}, "tool_calls");
    };
    requestCount++;
    if (requestCount === 1)
      tool("write_file", { path: "notes.txt", content: "created by model" });
    else if (requestCount === 2)
      tool("edit_file", {
        path: "sample.txt",
        oldText: "original",
        newText: "edited by model",
      });
    else {
      chunk({ role: "assistant", content: "Batch fixture completed." });
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
      resolve("apps/cli/src/index.ts"),
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
    const submitted = send("Make two edits\r");
    await wait("Batch fixture completed.", submitted);
    await wait("Enter send", submitted);
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe(
      "created by model",
    );
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe(
      "edited by model",
    );
    const list = send("/changes\r");
    await wait("File changes", list);
    // Both edits came from one model run, so the list labels that run.
    await wait("· run ", list);
    // Newest first: sample.txt, then notes.txt. Open the older one.
    const detail = send("\x1b[B\r");
    await wait("Roll back this run (2 changes)", detail);
    await wait("Roll back to here (2 changes)", detail);
    const confirm = send("\x1b[B".repeat(3) + "\r");
    await wait("Confirm rollback to here", confirm);
    await wait("1 created files will be removed", confirm);
    const done = send("\x1b[B\r");
    await wait("Rolled back 2 changes across 2 files", done);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await expect(access(join(cwd, "notes.txt"))).rejects.toThrow();
    await wait("/help", send("\x1b"));
    send("\x04");
    expect(await exited).toBe(0);
  } finally {
    terminal.kill();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
