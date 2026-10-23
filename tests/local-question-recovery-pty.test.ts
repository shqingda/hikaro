import { spawn } from "node-pty";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("recovers ordinary TUI questions after SIGKILL without replay and preserves unanswered questions on SIGTERM", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-local-question-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(raw);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "question-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (requests.length === 1 || requests.length === 3) {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "question-call",
            type: "function",
            function: {
              name: "ask_user",
              arguments: JSON.stringify({
                questions: [
                  {
                    id: "scope",
                    question: "Choose recovery scope",
                    options: ["Small", "Large"],
                  },
                ],
              }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "Continued with recovered answer" });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const seed = await Runtime.open({
    home,
    cwd,
    provider: "local",
    model: "fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    approve: async () => false,
  });
  const session = await seed.session();
  await seed.setPlanning(session, true);
  await seed.close();
  let terminal: ReturnType<typeof spawn> | undefined;
  let terminalExit: Promise<number> | undefined;
  try {
    let output = "";
    const start = () => {
      output = "";
      terminal = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("apps/cli/src/index.ts"),
          "--session",
          session.id,
          "--home",
          home,
          "--cwd",
          cwd,
        ],
        {
          cols: 110,
          rows: 40,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      terminal.onData((data) => {
        output += data;
      });
      terminalExit = new Promise<number>((done) =>
        terminal!.onExit(({ exitCode }) => done(exitCode)),
      );
    };
    start();
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
    await wait("Plan read-only");
    await wait("Question 1/1", send("Ask me about the scope\r"));
    expect(
      await store.pendingQuestions(session.id, "standalone:tui"),
    ).toHaveLength(1);
    terminal!.kill("SIGKILL");
    await terminalExit;
    start();
    await wait("/questions");
    await wait("Recovered question 1/1", send("/questions\r"));
    expect(requests).toHaveLength(1);
    await wait("Review answers", send("\x1b[B\r"));
    await wait("Answers not saved", send("\x1b[B\r"));
    expect(
      await store.pendingQuestions(session.id, "standalone:tui"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(1);
    // Let the actual crashed run lease expire; never alter storage to bypass it.
    await vi.waitFor(
      async () => {
        await store.assertLease(session.id);
      },
      { timeout: 35000, interval: 200 },
    );
    await wait("Recovered answers saved", send("\x1b[B\r"));
    expect(requests).toHaveLength(1);
    expect(await store.pendingQuestions(session.id, "standalone:tui")).toEqual(
      [],
    );
    const recovered = (await store.messages(session.id)).filter((m) =>
      m.text.includes("Answers to questions recovered"),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.text).toContain("Small");
    await wait("Plan read-only");
    await wait(
      "Continued with recovered answer",
      send("Continue with the saved answer\r"),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Small");
    await wait("Question 1/1", send("Ask again\r"));
    terminal!.kill("SIGTERM");
    expect(await terminalExit).toBe(0);
    expect(
      await store.pendingQuestions(session.id, "standalone:tui"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(3);
  } finally {
    terminal?.kill();
    await terminalExit;
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
