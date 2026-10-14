import { describe, it, expect } from "vitest";
import { spawn } from "node-pty";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AgentEvent, Message } from "../packages/core/src/types.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
it("enters fullscreen, handles Unicode and restores terminal on exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-pty-"));
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("apps/cli/src/index.ts"),
          "--demo",
          "--home",
          home,
        ],
        { cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" } },
      );
      let output = "";
      let phase = 0;
      const timeout = setTimeout(() => {
        child.kill();
        reject(Error("PTY timeout"));
      }, 10000);
      child.onData((data) => {
        output += data;
        if (phase === 0 && output.includes("/help")) {
          phase = 1;
          child.write("你好 👋\r");
        }
        if (phase === 1 && output.includes("You wrote:")) {
          phase = 2;
          child.resize(60, 18);
          child.write("\x04");
        }
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        try {
          expect(exitCode).toBe(0);
          expect(output).toContain("\x1b[?1049h");
          expect(output).toContain("\x1b[?1049l");
          expect(output).toContain("你好");
          done();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

async function within<T>(work: Promise<T>, label: string, ms = 8000) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

type FixtureRequest = {
  body: { messages: Array<{ role: string; content: unknown }> };
  response: ServerResponse;
  closed: Promise<void>;
  write: (text: string) => Promise<void>;
  finish: () => void;
};

async function withCriticalTui(
  scenario: (tui: {
    home: string;
    cwd: string;
    baseUrl: string;
    send: (input: string) => number;
    wait: (pattern: string | RegExp, after: number) => Promise<string>;
    nextRequest: () => Promise<FixtureRequest>;
    session: () => Promise<string>;
    prompt: (text: string) => Promise<FixtureRequest>;
    alive: () => boolean;
  }) => Promise<(db: DatabaseSync) => void>,
  seedSessions = false,
) {
  const home = await mkdtemp(join(tmpdir(), "hikaro-critical-pty-"));
  const cwd = join(home, "workspace");
  const requests: FixtureRequest[] = [];
  let deliver: ((request: FixtureRequest) => void) | undefined;
  let requestNumber = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/permission-ping") {
        res.end("NETWORK-REACHABLE");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const closed = new Promise<void>((done) => res.once("close", done));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const base = {
        id: `chatcmpl-pty-${++requestNumber}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "tui-e2e",
      };
      const chunk = (delta: object, finish: "stop" | null = null) => {
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      const request: FixtureRequest = {
        body: parsed,
        response: res,
        closed,
        write: async (text) => {
          chunk({ role: "assistant", content: text.slice(0, 1) });
          // Pace model chunks so the core's incremental-output coalescing can flush.
          await new Promise<void>((done, reject) => {
            const stopped = () => {
              clearTimeout(timer);
              reject(Error("Fixture response closed while streaming"));
            };
            const timer = setTimeout(() => {
              res.off("close", stopped);
              chunk({ content: text.slice(1) });
              done();
            }, 32);
            res.once("close", stopped);
          });
        },
        finish: () => {
          chunk({}, "stop");
          res.end("data: [DONE]\n\n");
        },
      };
      if (deliver) {
        const pending = deliver;
        deliver = undefined;
        pending(request);
      } else requests.push(request);
    } catch (error) {
      res.destroy(error as Error);
    }
  });
  let terminal: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number> | undefined;
  let exitCode: number | undefined;
  let output = "",
    position = 0;
  const changed = new Set<() => void>();
  try {
    await mkdir(cwd);
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
    const port = (server.address() as { port: number }).port;
    const initial: string[] = [];
    if (seedSessions) {
      const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
      try {
        for (const title of ["E2E A", "E2E B"]) {
          const session = await store.createSession(cwd, title, undefined, {
            provider: "local",
            model: "tui-e2e",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            settings: {},
          });
          if (!initial.length) initial.push("--session", session.id);
        }
      } finally {
        await store.close();
      }
    }
    terminal = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        resolve("apps/cli/src/index.ts"),
        "--provider",
        "local",
        "--model",
        "tui-e2e",
        "--base-url",
        `http://127.0.0.1:${port}/v1`,
        "--home",
        home,
        "--cwd",
        cwd,
        "--new",
        ...initial,
      ],
      {
        cwd,
        cols: 100,
        rows: 36,
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    terminal.onData((data) => {
      position += data.length;
      output = (output + data).slice(-40000);
      for (const notify of changed) notify();
    });
    exited = new Promise<number>((done) => {
      terminal!.onExit((event) => {
        exitCode = event.exitCode;
        for (const notify of changed) notify();
        done(exitCode);
      });
    });
    const send = (input: string) => {
      const after = position;
      terminal!.write(input);
      return after;
    };
    const wait = (pattern: string | RegExp, after: number) => {
      let check: () => void;
      const work = new Promise<string>((done, reject) => {
        check = () => {
          const fresh = stripVTControlCharacters(
            output.slice(Math.max(0, after - (position - output.length))),
          );
          if (
            typeof pattern === "string"
              ? fresh.includes(pattern)
              : pattern.test(fresh)
          )
            done(fresh);
          else if (exitCode !== undefined)
            reject(Error(`Unexpected PTY exit ${exitCode}: ${pattern}`));
        };
        changed.add(check);
        check();
      });
      return within(work, String(pattern)).finally(() => changed.delete(check));
    };
    const nextRequest = () =>
      within(
        new Promise<FixtureRequest>((done) => {
          const queued = requests.shift();
          if (queued) done(queued);
          else deliver = done;
        }),
        "local model request",
      );
    const session = async () => {
      const text = await wait(/Session: [\da-f-]{36}/, send("/status\r"));
      return text.match(/Session: ([\da-f-]{36})/)![1]!;
    };
    const prompt = async (text: string) => {
      const after = send(`${text}\r`);
      const request = await nextRequest();
      const reply = `fixture-response-${requestNumber}`;
      await wait("Working", after);
      await request.write(reply);
      // Keep the stream open until the busy UI is visible, then finish it.
      await wait(reply, after);
      const beforeFinish = position;
      request.finish();
      await wait("Enter send", beforeFinish);
      return request;
    };
    await wait("/help", 0);
    const verify = await scenario({
      home,
      cwd,
      baseUrl: `http://127.0.0.1:${port}`,
      send,
      wait,
      nextRequest,
      session,
      prompt,
      alive: () => exitCode === undefined,
    });
    send("\x04");
    expect(await within(exited, "normal PTY exit")).toBe(0);
    const db = new DatabaseSync(join(home, "sessions.sqlite"), {
      readOnly: true,
    });
    try {
      verify(db);
    } finally {
      db.close();
    }
  } catch (error) {
    throw Error(
      `${error instanceof Error ? error.message : String(error)}\nPTY tail:\n${stripVTControlCharacters(output).slice(-2500)}`,
      { cause: error },
    );
  } finally {
    try {
      if (terminal && exitCode === undefined) {
        terminal.kill("SIGKILL");
        await within(exited!, "PTY cleanup", 2000);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(home, { recursive: true, force: true });
    }
  }
}

function savedEvents(db: DatabaseSync, sessionId: string) {
  return db
    .prepare("SELECT type,data FROM events WHERE sessionId=? ORDER BY seq")
    .all(sessionId)
    .map((row) => ({
      type: String(row.type),
      data: JSON.parse(String(row.data)),
    })) as Pick<AgentEvent, "type" | "data">[];
}

function savedMessages(db: DatabaseSync, sessionId: string) {
  return savedEvents(db, sessionId)
    .filter((event) => event.type === "message")
    .map((event) => event.data.message as Message);
}

describe("critical TUI workflows", () => {
  it("switches sessions through the picker without mixing messages", async () => {
    await withCriticalTui(async (tui) => {
      const a = await tui.session();
      await tui.prompt("first-in-A");
      const pick = async (title: string, down = false) => {
        const after = tui.send("/sessions\r");
        await tui.wait("Sessions · page 1", after);
        // Seeded B is newest. A is the next row; select by the visible label.
        await tui.wait(`→ ${title}`, down ? tui.send("\x1b[B") : after);
        await tui.wait("Enter send", tui.send("\r"));
      };
      await pick("E2E B");
      const b = await tui.session();
      expect(b).not.toBe(a);
      await tui.prompt("first-in-B");
      await pick("E2E A", true);
      expect(await tui.session()).toBe(a);
      await tui.prompt("only-after-switch");
      return (db) => {
        const users = (id: string) =>
          savedMessages(db, id)
            .filter((message) => message.role === "user")
            .map((message) => message.text);
        expect(users(a)).toEqual(["first-in-A", "only-after-switch"]);
        expect(users(b)).toEqual(["first-in-B"]);
      };
    }, true);
  }, 20000);

  it("cancels the active stream and accepts a subsequent prompt", async () => {
    await withCriticalTui(async (tui) => {
      const id = await tui.session();
      const after = tui.send("cancel-request\r");
      const request = await tui.nextRequest();
      await tui.wait("Working", after);
      await request.write("cancel-stream-started");
      await tui.wait("cancel-stream-started", after);
      const cancelled = tui.send("\x03");
      await tui.wait("Stopped", cancelled);
      await tui.wait("Enter send", cancelled);
      await within(request.closed, "cancelled response connection closes");
      expect(request.response.writableEnded).toBe(false);
      expect(tui.alive()).toBe(true);
      await tui.prompt("after-cancel");
      return (db) => {
        expect(
          savedEvents(db, id)
            .filter((event) => event.type === "run.end")
            .map((event) => event.data.status),
        ).toEqual(["cancelled", "completed"]);
      };
    });
  }, 20000);

  it("compacts into a continuation and sends its summary to the model", async () => {
    await withCriticalTui(async (tui) => {
      const source = await tui.session();
      const goal = "Preserve KEEP-CONSTRAINT and file src/feature.ts.";
      await tui.prompt(goal);
      const after = tui.send("/compact\r");
      const request = await tui.nextRequest();
      const transcript = JSON.stringify(request.body.messages);
      expect(transcript).toContain("Create a faithful continuation summary");
      expect(transcript).toContain("KEEP-CONSTRAINT");
      expect(transcript).toContain("src/feature.ts");
      const summary =
        "KEEP-CONSTRAINT; file src/feature.ts; continue the task.";
      await tui.wait("Compacting", after);
      await request.write(summary);
      request.finish();
      await tui.wait(summary, after);
      await tui.wait("Enter send", after);
      const child = await tui.session();
      expect(child).not.toBe(source);
      const continued = await tui.prompt("continue-after-compact");
      expect(JSON.stringify(continued.body.messages)).toContain(summary);
      expect(JSON.stringify(continued.body.messages)).toContain(
        "continue-after-compact",
      );
      return (db) => {
        expect(
          db.prepare("SELECT parentId FROM sessions WHERE id=?").get(child),
        ).toMatchObject({ parentId: source });
        expect(
          savedMessages(db, source).map((message) => message.text),
        ).toEqual([goal, "fixture-response-1"]);
        expect(savedEvents(db, child)).toContainEqual({
          type: "context.compacted",
          data: { source },
        });
        expect(savedMessages(db, child)[0]?.text).toBe(
          `Continuation summary from session ${source}:\n${summary}`,
        );
      };
    });
  }, 20000);
});

describe("permissions and activity indicator", () => {
  it("applies the picker to real tools and animates the input border", async () => {
    await withCriticalTui(async (tui) => {
      await tui.wait(
        "Permissions · this workspace",
        tui.send("/permissions\r"),
      );
      await tui.wait("→ Approve for me", tui.send("\x1b[B"));
      await tui.wait("Permissions: Approve for me", tui.send("\r"));
      await tui.wait(
        "Permissions: Ask for approval",
        tui.send("/permissions ask\r"),
      );
      await tui.wait(
        "Permissions · this workspace",
        tui.send("/permissions\r"),
      );
      await tui.wait("→ Full Access", tui.send("\x1b[B\x1b[B"));
      await tui.wait("Permissions: Full Access", tui.send("\r"));
      const after = tui.send("activity-check\r");
      const request = await tui.nextRequest();
      await tui.wait("⠙ Working", after);
      await tui.wait("⠹ Working", after);
      await request.write("activity-completed");
      const finished = tui.send("");
      request.finish();
      await tui.wait("Enter send", finished);
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const probe = `fetch('${tui.baseUrl}/permission-ping').then(response => response.text()).then(console.log)`;
      const command = tui.send(
        `!printf permission-full > ../permission-full.txt; ${quote(process.execPath)} -e ${quote(probe)}\r`,
      );
      await tui.wait("NETWORK-REACHABLE", command);
      return () => {
        expect(
          readFileSync(join(tui.home, "permission-full.txt"), "utf8"),
        ).toBe("permission-full");
        const saved = JSON.parse(
          readFileSync(join(tui.home, "permissions.json"), "utf8"),
        );
        expect(saved[realpathSync(tui.cwd)]).toBe("full");
      };
    });
  }, 20000);
});

describe("TUI interaction fixes", () => {
  it("searches session titles and preserves settings focus with a persistent permission mode", async () => {
    await withCriticalTui(async (tui) => {
      await tui.wait("Permissions · Ask for approval", 0);
      const a = await tui.session();
      await tui.wait("Sessions · page 1", tui.send("/sessions\r"));
      await tui.wait("> E2E B", tui.send("E2E B"));
      await tui.wait("Enter send", tui.send("\r"));
      const b = await tui.session();
      expect(b).not.toBe(a);
      await tui.wait("Settings · saved immediately", tui.send("/settings\r"));
      await tui.wait("→ Completion bell", tui.send("\x1b[B\x1b[B\x1b[B"));
      await tui.wait(/→ Completion bell[\s\S]*On/, tui.send("\r"));
      await tui.wait(/→ Completion bell[\s\S]*Off/, tui.send("\r"));
      await tui.wait("→ Usage footer", tui.send("\x1b[A"));
      await tui.wait(/→ Usage footer[\s\S]*Hide/, tui.send("\r"));
      await tui.wait("Permissions · Ask for approval", tui.send("\x1b"));
      await tui.wait(
        "Permissions · Full Access",
        tui.send("/permissions full\r"),
      );
      return (db) => {
        const saved = JSON.parse(
          readFileSync(join(tui.home, "tui-preferences.json"), "utf8"),
        );
        expect(saved).toMatchObject({
          completionBell: false,
          showUsage: false,
          showToolDetails: false,
        });
        expect(
          db
            .prepare("SELECT sessionId FROM workspace_state WHERE cwd=?")
            .get(tui.cwd),
        ).toMatchObject({ sessionId: b });
      };
    }, true);
  }, 20000);
});
