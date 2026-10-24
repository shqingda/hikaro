import { spawn as spawnProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { savePermissionMode } from "../packages/runtime/src/permissions.ts";

it("runs Plan, questions, rollback and execution management through an attached TUI and separate host", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "sample.txt"), "original");
  await savePermissionMode(home, cwd, "full");
  let childStarted = false;
  const counts = new Map<string, number>();
  const seenTools: string[][] = [];
  let blocked = false;
  let answered = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const messages = body.messages as { role: string; content: unknown }[];
    const content = messages.filter((m) => m.role === "user").at(-1)?.content;
    const prompt =
      typeof content === "string" ? content : JSON.stringify(content);
    const n = (counts.get(prompt!) ?? 0) + 1;
    counts.set(prompt!, n);
    const execution = prompt?.includes("The user reviewed and approved");
    const revision = prompt?.includes("Revise the plan");
    if (!execution)
      seenTools.push(
        body.tools.map((t: { function: { name: string } }) => t.function.name),
      );
    blocked ||= JSON.stringify(messages).includes("Plan mode is read-only");
    answered ||= messages.some(
      (m) =>
        m.role === "tool" &&
        JSON.stringify(m.content).includes("scope") &&
        JSON.stringify(m.content).includes("Small"),
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "plan-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    const tool = (name: string, args: object) => {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${counts.size}-${n}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      chunk({}, "tool_calls");
    };
    if (prompt?.includes("child fixture")) {
      childStarted = true;
      chunk({ role: "assistant", content: "Child is working" });
      return;
    }
    if (prompt?.includes("prioritized queued")) {
      chunk({ role: "assistant", content: "Prioritized message executed" });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (prompt?.includes("edited queued")) {
      chunk({ role: "assistant", content: "Queued edit executed" });
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (prompt?.includes("start execution")) {
      if (n === 1)
        tool("terminal_start", {
          command:
            "printf 'READY\\n'; read answer; printf 'RESPONSE:%s\\n' \"$answer\"; sleep 30",
          unrestricted: true,
        });
      else if (n === 2) tool("subagent", { task: "child fixture" });
      else {
        chunk({ role: "assistant", content: "Main finished" });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    if (execution && n === 1)
      tool("write_file", {
        path: "sample.txt",
        content: "implemented",
        expected: "original",
      });
    else if (execution) {
      chunk({ role: "assistant", content: "Execution verified" });
      chunk({}, "stop");
    } else if (revision && n === 1)
      tool("submit_plan", {
        title: "Revised plan",
        steps: ["Update sample.txt as requested"],
        validation: "Read the final file",
      });
    else if (revision) {
      chunk({ role: "assistant", content: "Revised plan ready" });
      chunk({}, "stop");
    } else if (n === 1) tool("read_file", { path: "sample.txt" });
    else if (n === 2)
      tool("write_file", {
        path: "sample.txt",
        content: "bad",
        expected: "original",
      });
    else if (n === 3)
      tool("ask_user", {
        questions: [
          {
            id: "scope",
            question: "Choose the scope",
            options: ["Small", "Large"],
          },
        ],
      });
    else if (n === 4)
      tool("submit_plan", {
        title: "Initial plan",
        steps: ["Update sample.txt"],
        validation: "Read final contents",
      });
    else {
      chunk({ role: "assistant", content: "Plan ready" });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
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
  host.stdout.on("data", (data) => {
    hostOutput += data;
  });
  host.stderr.on("data", (data) => {
    hostOutput += data;
  });
  const hostExited = new Promise<void>((done) => host.on("exit", () => done()));
  try {
    await vi.waitFor(() => expect(hostOutput).toContain("shared host ready"), {
      timeout: 8000,
    });
  } catch (error) {
    host.kill("SIGTERM");
    await hostExited;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  const terminal = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("apps/cli/src/index.ts"),
      "--attach",
      "--new",
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
    await wait("Attached to shared host");
    await wait("Choose the scope", send("/plan update sample\r"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Review answers", send("\x1b[B\r"));
    await wait("Plan review", send("\x1b[B\r"));
    expect(blocked).toBe(true);
    expect(answered).toBe(true);
    expect(
      seenTools.every(
        (names) => !names.includes("write_file") && !names.includes("shell"),
      ),
    ).toBe(true);
    await wait("Plan kept read-only", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Plan review", send("/plan\r"));
    await wait("Changes to the plan", send("\x1b[B".repeat(2) + "\r"));
    await wait("Plan review", send("Keep it focused\r"));
    await wait("Confirm plan execution", send("\x1b[B\r"));
    await wait("Plan review", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Confirm plan execution", send("\x1b[B\r"));
    await wait("Execution verified", send("\x1b[B\r"));
    const progress = send("/plan progress\r");
    await wait("Plan progress · reported by the model", progress);
    await wait("steps reported completed", progress);
    await wait("file edits recorded since approval", progress);
    await wait("Enter send", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("implemented");
    await wait("File changes", send("/changes\r"));
    await wait("Roll back this edit", send("\r"));
    await wait("Confirm file rollback", send("\x1b[B\r"));
    const rollback = send("\x1b[B\r");
    await wait("Rolled back sample.txt", rollback);
    await wait("File changes", rollback);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Enter send", send("\x1b[B".repeat(2) + "\r"));
    const executionOffset = send("start execution\r");
    await vi.waitFor(
      () =>
        expect(
          childStarted,
          stripVTControlCharacters(output.slice(executionOffset)) +
            "\nRequests: " +
            JSON.stringify([...counts]),
        ).toBe(true),
      { timeout: 8000 },
    );
    await wait("Message queued on host", send("discard me\r"));
    await wait("Message queued on host", send("kept message\r"));
    await wait("Message queued on host", send("prioritized queued\r"));
    await wait("Execution manager", send("/tasks\r"));
    await wait("Pending messages · page 1", send("\r"));
    await wait("Remove message", send("\r"));
    await wait("Remove pending message?", send("\x1b[B".repeat(3) + "\r"));
    await wait("Pending messages · page 1", send("\x1b[B\r"));
    await wait("Edit message", send("\r"));
    await wait("Edit pending message", send("\x1b[B\r"));
    await wait("Pending messages · page 1", send("\x01\x0bedited queued\r"));
    await wait("Move to front", send("\x1b[B\r"));
    await wait("1. prioritized queued", send("\x1b[B".repeat(2) + "\r"));
    await wait("Execution manager", send("\x1b"));
    await wait("Background terminals · page 1", send("\x1b[B\r"));
    await wait("Send a line", send("\r"));
    await wait("Send a line to terminal", send("\x1b[B\r"));
    await wait("Send terminal input?", send("hello\r"));
    await wait("Background terminals · page 1", send("\x1b[B\r"));
    await wait("RESPONSE:hello", send("\r"));
    await wait("Stop this task?", send("\x1b[B".repeat(2) + "\r"));
    await wait("Background terminals · page 1", send("\x1b[B\r"));
    await wait("State: exited", send("\r"));
    await wait("Background terminals · page 1", send("\x1b"));
    await wait("Execution manager", send("\x1b"));
    await wait("Child agents · page 1", send("\x1b[B".repeat(2) + "\r"));
    await wait("Task: child fixture", send("\r"));
    await wait("Stop this task?", send("\x1b[B\r"));
    await wait("Child agents · page 1", send("\x1b[B\r"));
    await wait("Main finished");
    await wait("State: cancelled", send("\r"));
    expect(
      [...counts.keys()].some(
        (text) =>
          text.includes("edited queued") || text.includes("prioritized queued"),
      ),
    ).toBe(false);
    await wait("Child agents · page 1", send("\x1b"));
    await wait("Execution manager", send("\x1b"));
    await wait("Queued edit executed", send("\x1b"));
    const requests = [...counts.keys()];
    expect(requests.some((text) => text.includes("discard me"))).toBe(false);
    expect(requests.some((text) => text.includes("kept message"))).toBe(false);
    expect(
      requests.findIndex((text) => text.includes("prioritized queued")),
    ).toBeLessThan(
      requests.findIndex((text) => text.includes("edited queued")),
    );
    send("\x04");
    expect(await exited).toBe(0);
  } finally {
    terminal.kill();
    host.kill("SIGTERM");
    await hostExited;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 45000);
