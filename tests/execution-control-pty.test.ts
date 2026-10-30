import { workbenchKeys } from "./workbench-pty-helpers.ts";
import { expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { savePermissionMode } from "../packages/runtime/src/permissions.ts";

it("manages queued messages, terminal input/exit, and child cancellation from a real TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-execution-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await savePermissionMode(home, cwd, "full");
  const received: string[] = [];
  let releaseRoot: (() => void) | undefined;
  let childStarted = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const messages = body.messages as { role: string; content: unknown }[];
    const lastUser = messages.filter((m) => m.role === "user").at(-1)?.content;
    const prompt =
      typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser);
    received.push(prompt ?? "");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "execution-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    const tool = (name: string, args: object) => {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      chunk({}, "tool_calls");
      res.end("data: [DONE]\n\n");
    };
    if (prompt?.includes("child fixture")) {
      childStarted = true;
      chunk({ role: "assistant", content: "Child is working" });
      return;
    }
    if (prompt?.includes("edited queued")) {
      chunk({ role: "assistant", content: "Queued edit executed" });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    const tools = messages.filter((m) => m.role === "tool").length;
    if (!tools) {
      chunk({ role: "assistant", content: "Fixture waiting" });
      releaseRoot = () =>
        tool("terminal_start", {
          command:
            "printf 'READY\\n'; read answer; printf 'RESPONSE:%s\\n' \"$answer\"; sleep 30",
          unrestricted: true,
        });
    } else if (tools === 1) tool("subagent", { task: "child fixture" });
    else {
      chunk({ role: "assistant", content: "Main finished" });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
    }
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
            `Missing ${text}: ${stripVTControlCharacters(output.slice(offset, offset + 2500) + output.slice(-1500))}`,
          ),
        );
      }, 8000);
      watchers.add(check);
      check();
    });
  try {
    await wait("Enter send");
    send("start fixture\r");
    await vi.waitFor(() => expect(releaseRoot).toBeTypeOf("function"), {
      timeout: 8000,
    });
    await wait("1 pending", send("discard me\x18\r"));
    await wait("2 pending", send("kept message\x18\r"));
    const keys = workbenchKeys(send, wait, () => output);
    await keys.tab("Activity");
    await keys.object("discard me", "discard me", "Remove message");
    await keys.confirm("4", "Remove message", "↑↓ select");
    await keys.object("kept message", "kept message", "Edit message");
    await wait("Edit message", send("2"));
    await wait("↑↓ select", send("\x01\x0bedited queued\r"));
    await keys.object("edited queued", "edited queued", "Edit message");
    await keys.tab("Conversation");
    releaseRoot!();
    await vi.waitFor(() => expect(childStarted).toBe(true), { timeout: 8000 });
    await keys.tab("Activity");
    await keys.object("terminals", "printf", "Send a line");
    await wait("Send a line", send("2"));
    await wait("Send terminal input?", send("hello\r"));
    send("\x1b[B\r");
    await keys.refresh("RESPONSE:hello");
    await keys.confirm("3", "Stop terminal", "1/");
    await keys.refresh("State: exited");
    await keys.object("children", "child fixture", "Stop child agent");
    await keys.confirm("2", "Stop child agent", "1/");
    await keys.refresh("State: cancelled");
    // No page-level queue hold: completion dispatches the queued edit while Activity stays open.
    await vi.waitFor(
      () =>
        expect(received.some((text) => text.includes("edited queued"))).toBe(
          true,
        ),
      { timeout: 8000 },
    );
    await keys.tab("Conversation");
    await wait("Main finished");
    await wait("Queued edit executed");
    expect(received.some((text) => text.includes("discard me"))).toBe(false);
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
