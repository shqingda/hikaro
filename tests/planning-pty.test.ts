import { expect, it } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { savePermissionMode } from "../packages/runtime/src/permissions.ts";

it("explores read-only, answers a question, revises and approves a plan before writing in the TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "sample.txt"), "original");
  await savePermissionMode(home, cwd, "full");
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
    if (execution && n === 1)
      tool("write_file", {
        path: "sample.txt",
        content: "implemented",
        expected: "original",
      });
    else if (execution && n === 2)
      tool("update_plan_step", {
        plan_id: /approved plan ([0-9a-f-]{36})/.exec(prompt!)![1],
        step: 1,
        status: "completed",
        note: "sample.txt now reads implemented",
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
    await wait("Choose the scope", send("/plan update sample\r"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Review answers", send("\x1b[B\r"));
    await wait("Plan review", send("\x1b[B\r"));
    expect(blocked).toBe(true);
    expect(answered).toBe(true);
    expect(
      seenTools.every(
        (names) =>
          !names.includes("write_file") &&
          !names.includes("shell") &&
          !names.includes("update_plan_step"),
      ),
    ).toBe(true);
    await wait("Plan kept read-only", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Plan review", send("/plan\r"));
    await wait("Changes to the plan", send("\x1b[B".repeat(2) + "\r"));
    // The revised review panel opens after the turn ends, not when its text streams.
    await wait("Approve and execute", send("Keep it focused\r"));
    await wait("Confirm plan execution", send("\x1b[B\r"));
    await wait("Plan review", send("\x1b"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("original");
    await wait("Confirm plan execution", send("\x1b[B\r"));
    await wait("Execution verified", send("\x1b[B\r"));
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("implemented");
    const progress = send("/plan progress\r");
    await wait("1/1 steps reported completed", progress);
    await wait("✓ Completed · Update sample.txt as requested", progress);
    await wait("sample.txt now reads implemented", progress);
    await wait("1 file edits recorded since approval", progress);
    await wait("Inspect execution evidence", progress);
    await wait("Evidence by step", send("\x1b[B".repeat(2) + "\r"));
    const evidence = send("\x1b[B\r");
    await wait("Execution evidence", evidence);
    // The action can arrive in the same frame as the heading. End may not
    // repaint an already visible row, so observe the whole panel transition.
    send("\x1b[F");
    await wait("Inspect file differences", evidence);
    await wait("Plan progress", send("\x1b"));
    await wait("Enter send", send("\x1b"));
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
