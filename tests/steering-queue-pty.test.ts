import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";
import type { AgentEvent } from "../packages/core/src/types.ts";

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
    resolve("packages/cli/src/index.ts"),
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
        resolve("packages/cli/src/index.ts"),
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

it("restores steering after SIGKILL in the built TUI and applies only the explicitly confirmed item", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-steering-restart-"));
  const cwd = join(home, "workspace"),
    cli = resolve("dist/hikaro.mjs");
  await mkdir(cwd);
  const hosts: Array<{
    process: ReturnType<typeof spawnProcess>;
    exited: Promise<void>;
  }> = [];
  let client: SharedHostClient | undefined,
    observer: SharedHostClient | undefined;
  let terminal: ReturnType<typeof spawn> | undefined,
    terminalExit: Promise<number> | undefined;
  const startHost = async () => {
    const process = spawnProcess(globalThis.process.execPath, [
      cli,
      "--host",
      "--demo",
      "--home",
      home,
      "--cwd",
      cwd,
    ]);
    let output = "";
    process.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    process.stderr!.on("data", (chunk) => {
      output += chunk;
    });
    const host = {
      process,
      exited: new Promise<void>((done) => process.on("exit", () => done())),
    };
    hosts.push(host);
    await vi.waitFor(() => expect(output).toContain("shared host ready"), {
      timeout: 8000,
    });
    return host;
  };
  try {
    const first = await startHost();
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "recovery-owner",
    });
    await client.request("hello");
    const session = (await client.request("session.create")) as { id: string };
    await client.request("steer", {
      sessionId: session.id,
      text: "recover first",
    });
    await client.request("steer", {
      sessionId: session.id,
      text: "leave unconfirmed",
    });
    first.process.kill("SIGKILL");
    await first.exited;
    await client.close();
    client = undefined;
    await startHost();
    observer = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "recovery-observer",
    });
    await observer.request("hello");
    await observer.request("session.resume", { sessionId: session.id });
    const events = async () =>
      (await observer!.request("events.read", {
        sessionId: session.id,
      })) as AgentEvent[];
    expect(
      (await events()).filter((event) => event.type === "run.start"),
    ).toEqual([]);
    let output = "";
    terminal = spawn(
      process.execPath,
      [
        cli,
        "--attach",
        "--client-id",
        "recovery-owner",
        "--session",
        session.id,
        "--home",
        home,
        "--cwd",
        cwd,
      ],
      {
        cols: 110,
        rows: 38,
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    terminal.onData((chunk) => {
      output += chunk;
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
    await wait("Attached to shared host");
    await wait("Execution manager", send("/tasks\r"));
    await wait("Steering messages · page 1", send("\x1b[B".repeat(3) + "\r"));
    await wait("Apply recovered steering", send("\r"));
    await wait("Apply recovered steering?", send("\x1b[B\r"));
    await wait("Steering messages · page 1", send("\x1b[B\r"));
    await wait("Execution manager", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    expect(
      (await events()).filter((event) => event.type === "run.start"),
    ).toEqual([]);
    send("apply now\r");
    await vi.waitFor(
      async () =>
        expect(
          (await events()).filter((event) => event.type === "run.end").at(-1)
            ?.data.status,
          stripVTControlCharacters(output).slice(-3000),
        ).toBe("completed"),
      { timeout: 8000 },
    );
    const users = (await events())
      .filter((event) => event.type === "message")
      .map((event) => event.data.message as { role: string; text: string })
      .filter((message) => message.role === "user");
    expect(users.map((message) => message.text)).toEqual([
      "apply now",
      "recover first",
    ]);
    const remaining = (await observer.request("execution.read", {
      sessionId: session.id,
      kind: "steering",
    })) as Array<{ id: string; state: string; title: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      title: "1. leave unconfirmed",
      state: "Recovered · confirmation required",
    });
    const hold = (await observer.request("execution.hold", {
      sessionId: session.id,
    })) as { token: string };
    await expect(
      observer.request("execution.action", {
        sessionId: session.id,
        kind: "steering",
        id: remaining[0]!.id,
        action: "resume",
        token: hold.token,
      }),
    ).rejects.toThrow(/original client identity/);
    await observer.request("execution.release", {
      sessionId: session.id,
      token: hold.token,
    });
    send("\x04");
    expect(await terminalExit).toBe(0);
  } finally {
    terminal?.kill();
    await terminalExit;
    await client?.close();
    await observer?.close();
    for (const host of hosts) {
      host.process.kill("SIGTERM");
      await host.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 35000);
