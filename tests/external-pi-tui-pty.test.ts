import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";

// A separate Pi-shaped process exercises the production CLI, transport and TUI.
// It never loads Pi configuration, credentials, a provider, or a real account.
const fakePiSource = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("1.4.0");
  process.exit(0);
}
const home = process.env.HIKARO_TEST_PI_HOME;
writeFileSync(join(home, "pi.pid"), String(process.pid));
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let turn = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(join(home, "requests.jsonl"), JSON.stringify({ type: request.type }) + "\n");
  const respond = (data = {}) => emit({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "get_state") {
    respond({ sessionId: "external-pi-fixture", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 });
  } else if (request.type === "prompt") {
    respond({});
    emit({ type: "agent_start" });
    const text = request.message === "slow" ? "Waiting for cancellation" : "External Pi response";
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    const toolCallId = "tool-" + (++turn);
    emit({ type: "tool_execution_start", toolCallId, toolName: "read_file", args: { path: "src/fixture.ts" } });
    if (request.message !== "slow") setTimeout(() => {
      emit({ type: "tool_execution_end", toolCallId, toolName: "read_file", result: { content: [{ type: "text", text: "fixture output" }] }, isError: false });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() } });
      emit({ type: "agent_settled", aborted: false });
    }, 120);
  } else if (request.type === "abort") {
    respond({});
    emit({ type: "agent_settled", aborted: true });
  } else {
    respond({});
  }
}).on("close", () => process.exit(0));
`;

const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

it("renders external Pi tools, cancels, and preserves the draft and authority after idle Pi exits", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-external-pi-pty-")),
  );
  const cwd = join(home, "workspace");
  const source = join(home, "fake-pi.mjs");
  const command = join(home, "pi");
  let terminal: ReturnType<typeof spawn> | undefined;
  let exited: number | undefined;
  let piPid: number | undefined;
  let piTerminated = false;
  let output = "";
  try {
    await mkdir(cwd);
    await writeFile(source, fakePiSource);
    await writeFile(
      command,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(source)} "$@"\n`,
      { mode: 0o700 },
    );
    terminal = spawn(
      process.execPath,
      [
        resolve(process.env.HIKARO_TEST_BIN ?? "dist/hikaro.mjs"),
        "--backend",
        "pi",
        "--pi-command",
        command,
        "--home",
        home,
        "--cwd",
        cwd,
      ],
      {
        cwd,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          HIKARO_TEST_PI_HOME: home,
        },
      },
    );
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      exited = exitCode;
    });
    const wait = (text: string, offset = 0) =>
      vi.waitFor(
        () => {
          expect(stripVTControlCharacters(output.slice(offset))).toContain(
            text,
          );
        },
        { timeout: 10000 },
      );
    const send = (text: string) => {
      const offset = output.length;
      terminal!.write(text);
      return offset;
    };

    await wait("Managed by Pi");
    piPid = Number(await readFile(join(home, "pi.pid"), "utf8"));
    expect(Number.isSafeInteger(piPid) && piPid > 0).toBe(true);
    const round = send("round\r");
    await wait("External Pi response", round);
    await wait("Done  read_file  src/fixture.ts", round);
    await wait("Ready", round);

    const slow = send("slow\r");
    await wait("Waiting for cancellation", slow);
    await wait("Running  read_file  src/fixture.ts", slow);
    await wait("Stopped", send("\x03"));
    const requests = (await readFile(join(home, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type);
    expect(requests.slice(-2)).toEqual(["clear_queue", "abort"]);

    await wait("draft survives", send("draft survives"));
    const disconnected = output.length;
    process.kill(piPid, "SIGTERM");
    piTerminated = true;
    await wait("Disconnected", disconnected);
    expect(exited).toBeUndefined();
    // A resize forces a full new frame, so these assertions cannot pass on old
    // startup output or a draft that was only visible before the disconnect.
    const redraw = output.length;
    terminal.resize(101, 30);
    await wait("Disconnected", redraw);
    await wait("Managed by Pi", redraw);
    await wait("draft survives", redraw);
    await wait("draft survives after exit", send(" after exit"));
    send("\x04");
    await vi.waitFor(() => expect(exited).toBe(0), { timeout: 5000 });
  } finally {
    if (!piTerminated && piPid) {
      try {
        process.kill(piPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (terminal && exited === undefined) {
      terminal.kill("SIGKILL");
      await vi.waitFor(() => expect(exited).toBeDefined(), { timeout: 3000 });
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
