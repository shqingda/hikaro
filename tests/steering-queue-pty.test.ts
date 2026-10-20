import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";

it("edits, prioritizes and removes steering through attached TUI before the next model turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-steering-pty-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const inputs: string[][] = [];
  let finishFirst: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    inputs.push(
      body.messages
        .filter((m: { role: string }) => m.role === "user")
        .map((m: { content: string }) => m.content),
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "steering-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    chunk({
      role: "assistant",
      content: inputs.length === 1 ? "First turn complete" : "Steering applied",
    });
    const finish = () => {
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    if (inputs.length === 1) finishFirst = finish;
    else finish();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const host = spawnProcess(process.execPath, [
    "--import",
    "tsx",
    resolve("apps/cli/src/index.ts"),
    "--host",
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
  ]);
  let hostOutput = "";
  host.stdout.on("data", (d) => {
    hostOutput += d;
  });
  host.stderr.on("data", (d) => {
    hostOutput += d;
  });
  const hostExit = new Promise<void>((done) => host.on("exit", () => done()));
  let client: SharedHostClient | undefined,
    terminal: ReturnType<typeof spawn> | undefined,
    terminalExit: Promise<number> | undefined;
  try {
    await vi.waitFor(() => expect(hostOutput).toContain("shared host ready"), {
      timeout: 8000,
    });
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "steering",
    });
    await client.request("hello");
    const session = (await client.request("session.create")) as { id: string };
    await client.request("prompt", { text: "start", sessionId: session.id });
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    for (const text of [
      "first steering",
      "priority steering",
      "discard steering",
    ])
      await client.request("steer", { text, sessionId: session.id });
    await client.close();
    client = undefined;
    let output = "";
    terminal = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("apps/cli/src/index.ts"),
        "--attach",
        "--client-id",
        "steering",
        "--session",
        session.id,
        "--home",
        home,
        "--cwd",
        cwd,
      ],
      { cols: 110, rows: 38, env: { ...process.env, TERM: "xterm-256color" } },
    );
    terminal.onData((d) => {
      output += d;
    });
    terminalExit = new Promise<number>((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
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
    await wait("Ctrl+C stops");
    await wait("Execution manager", send("/tasks\r"));
    await wait("Steering messages · page 1", send("\x1b[B".repeat(3) + "\r"));
    await wait("Edit message", send("\r"));
    await wait("Edit pending message", send("\x1b[B\r"));
    await wait("Steering messages · page 1", send("\x01\x0bedited steering\r"));
    await wait("Move to front", send("\x1b[B\r"));
    await wait("1. priority steering", send("\x1b[B".repeat(2) + "\r"));
    await wait("Remove message", send("\x1b[B".repeat(2) + "\r"));
    await wait("Remove pending message?", send("\x1b[B".repeat(3) + "\r"));
    await wait("Steering messages · page 1", send("\x1b[B\r"));
    finishFirst!();
    await wait("First turn complete");
    expect(inputs).toHaveLength(1);
    await wait("Execution manager", send("\x1b"));
    await wait("Steering applied", send("\x1b"));
    expect(inputs).toEqual([
      ["start"],
      ["start", "priority steering", "edited steering"],
    ]);
    send("\x04");
    expect(await terminalExit).toBe(0);
  } finally {
    terminal?.kill();
    await terminalExit;
    await client?.close();
    host.kill("SIGTERM");
    await hostExit;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 35000);
