import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("reads completed execution history through attached TUI after host restart without replaying work", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-history-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const hosts: {
    child: ReturnType<typeof spawnProcess>;
    exit: Promise<void>;
  }[] = [];
  let client: SharedHostClient | undefined;
  let terminal: ReturnType<typeof spawn> | undefined;
  let terminalExit: Promise<number> | undefined;
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  async function startHost() {
    const child = spawnProcess(process.execPath, [
      "--import",
      "tsx",
      resolve("packages/cli/src/index.ts"),
      "--host",
      "--demo",
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
  }
  try {
    const first = await startHost();
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "recovery",
    });
    await client.request("hello");
    const session = (await client.request("session.create")) as { id: string };
    await client.request("prompt", {
      text: "HISTORY-COMPLETED",
      sessionId: session.id,
    });
    await vi.waitFor(
      async () =>
        expect((await store.latestRunEvent(session.id))?.data.status).toBe(
          "completed",
        ),
      { timeout: 8000 },
    );
    const completed = await store.latestRunEvent(session.id);
    await expect(
      client.request("execution.action", {
        sessionId: session.id,
        kind: "history",
        id: completed!.data.runId,
        action: "stop",
      }),
    ).rejects.toThrow(/read-only/);
    first.child.kill("SIGTERM");
    await first.exit;
    await client.close();
    client = undefined;
    await startHost();
    let output = "";
    terminal = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("packages/cli/src/index.ts"),
        "--attach",
        "--client-id",
        "recovery",
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
    terminal.onData((data) => {
      output += data;
    });
    terminalExit = new Promise<number>((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
    const send = (text: string) => {
      const offset = output.length;
      terminal!.write(text);
      return offset;
    };
    let step = 0;
    const wait = async (text: string, offset = 0) => {
      const current = ++step;
      await vi.waitFor(
        () =>
          expect(
            stripVTControlCharacters(output.slice(offset)),
            `Step ${current}: ${text}`,
          ).toContain(text),
        { timeout: 8000 },
      );
    };
    await wait("Enter send");
    await wait("Activity", send("/tasks\r"));
    await wait("› history", 0);
    await wait("State: completed", send("\r"));
    await wait("Read-only history");
    expect(stripVTControlCharacters(output)).toContain(
      String(completed!.data.runId),
    );
    await wait("Enter inspect", send("\x1b"));
    expect(
      (await store.recentRunEvents(session.id)).filter(
        (e) => e.type === "run.start",
      ),
    ).toHaveLength(1);
    send("\x04");
    expect(await terminalExit).toBe(0);
  } finally {
    terminal?.kill();
    await terminalExit;
    await client?.close();
    for (const host of hosts) host.child.kill("SIGTERM");
    await Promise.all(hosts.map((h) => h.exit));
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40000);
