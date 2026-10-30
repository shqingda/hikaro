import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { Planning } from "../packages/runtime/src/planning.ts";

it("recovers unsubmitted answer drafts after attached TUI and host SIGKILL, then continues only on a new prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-question-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const requests: string[] = [];
  const questions = [
    {
      id: "scope",
      question: "Choose recovery scope",
      options: ["Small", "Large"],
    },
    { id: "detail", question: "Describe the recovery boundary" },
  ];
  const draftText = "待确认  draft 🌅 42";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(raw);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "question-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (requests.length === 1) {
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
                questions,
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
  const hosts: {
    child: ReturnType<typeof spawnProcess>;
    exit: Promise<void>;
  }[] = [];
  let client: SharedHostClient | undefined;
  let terminal: ReturnType<typeof spawn> | undefined;
  let terminalExit: Promise<number> | undefined;
  let output = "";
  const startTerminal = (sessionId: string) => {
    output = "";
    terminal = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("packages/cli/src/index.ts"),
        "--attach",
        "--client-id",
        "question-owner",
        "--session",
        sessionId,
        "--home",
        home,
        "--cwd",
        cwd,
      ],
      { cols: 110, rows: 40, env: { ...process.env, TERM: "xterm-256color" } },
    );
    terminal.onData((data) => {
      output += data;
    });
    terminalExit = new Promise<number>((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
  };
  const send = (text: string) => {
    const offset = output.length;
    terminal!.write(text);
    return offset;
  };
  const wait = (text: string, offset = 0) =>
    vi.waitFor(
      () =>
        expect(stripVTControlCharacters(output.slice(offset))).toContain(text),
      { timeout: 8000 },
    );
  const startHost = async () => {
    const child = spawnProcess(process.execPath, [
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
    let output = "";
    child.stdout!.on("data", (data) => {
      output += data;
    });
    child.stderr!.on("data", (data) => {
      output += data;
    });
    const host = {
      child,
      exit: new Promise<void>((done) => child.on("exit", () => done())),
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
      clientId: "question-owner",
    });
    await client.request("hello");
    const session = (await client.request("session.create")) as { id: string };
    await client.request("plan.set", { sessionId: session.id, active: true });
    await client.close();
    client = undefined;
    const planning = new Planning(home);
    const expectReadOnly = async () => {
      await planning.load(session.id, true);
      expect(planning.get(session.id).active).toBe(true);
    };
    startTerminal(session.id);
    await wait("Plan read-only");
    await wait("Question 1/2", send("Ask me about the scope\r"));
    const pending = await store.pendingQuestions(
      session.id,
      "local:question-owner",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.questions).toEqual(questions);
    const draftKey = {
      id: pending[0]!.id,
      sessionId: session.id,
      scope: "local:question-owner",
    };
    await wait("Describe the recovery boundary", send("\x1b[B\r"));
    await wait("Your answer", send("\x1b[B\r"));
    // Persist the unfinished input without pressing Enter or submitting answers.
    await wait(draftText, send(draftText));
    await vi.waitFor(
      async () => {
        const saved = await store.questionDraft(draftKey);
        expect(saved.revision).toBeGreaterThan(0);
        expect(saved.draft).toMatchObject({
          answers: { scope: "Small" },
          inputs: { detail: draftText },
          position: { kind: "input", questionId: "detail" },
        });
      },
      { timeout: 8000 },
    );
    expect(
      (await store.events(session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
    await expectReadOnly();
    terminal!.kill("SIGKILL");
    await terminalExit;
    first.child.kill("SIGKILL");
    await first.exit;
    await startHost();
    startTerminal(session.id);
    await wait("Your answer");
    await wait(draftText);
    expect(requests).toHaveLength(1);
    expect(
      (await store.pendingQuestions(session.id, "local:question-owner"))[0]!
        .questions,
    ).toEqual(questions);
    await expectReadOnly();
    const reviewAt = send("\r");
    await wait("Review answers", reviewAt);
    await wait("Choose recovery scope", reviewAt);
    await wait("Small", reviewAt);
    await wait("Describe the recovery boundary", reviewAt);
    await wait(draftText, reviewAt);
    expect(
      (await store.events(session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
    // Do not alter or bypass the crashed run's 30-second execution lease.
    await vi.waitFor(
      async () => {
        await store.assertLease(session.id);
      },
      { timeout: 35000, interval: 200 },
    );
    expect(requests).toHaveLength(1);
    await wait("Recovered answers saved", send("\x1b[B\r"));
    expect(requests).toHaveLength(1);
    expect(
      await store.pendingQuestions(session.id, "local:question-owner"),
    ).toEqual([]);
    const recovered = (await store.messages(session.id)).filter((m) =>
      m.text.includes("Answers to questions recovered"),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.text).toContain("Small");
    expect(recovered[0]!.text).toContain(draftText);
    const responses = (await store.events(session.id)).filter(
      (e) => e.type === "question.response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data).toMatchObject({
      answers: { scope: "Small", detail: draftText },
      recovered: true,
    });
    await expect(store.questionDraft(draftKey)).rejects.toThrow();
    const inspection = new DatabaseSync(join(home, "sessions.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        inspection
          .prepare("SELECT count(*) AS count FROM question_drafts")
          .get()?.count,
      ).toBe(0);
    } finally {
      inspection.close();
    }
    await expectReadOnly();
    await wait("Plan read-only");
    await wait(
      "Continued with recovered answer",
      send("Continue with the saved answer\r"),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Small");
    expect(requests[1]).toContain(draftText);
    send("\x04");
    expect(await terminalExit).toBe(0);
  } finally {
    terminal?.kill();
    await terminalExit;
    await client?.close();
    for (const host of hosts) host.child.kill("SIGTERM");
    await Promise.all(hosts.map((h) => h.exit));
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
