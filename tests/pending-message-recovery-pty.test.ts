import { workbenchKeys } from "./workbench-pty-helpers.ts";
import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("recovers a durably accepted queue after host SIGKILL and explicitly resumes it through attached TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-pending-pty-"));
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
    await client.request("execution.hold", { sessionId: session.id });
    await client.request("prompt", {
      text: "RECOVER-PENDING-EXACTLY-ONCE",
      sessionId: session.id,
    });
    expect((await store.pendingPrompts(session.id)).map((q) => q.text)).toEqual(
      ["RECOVER-PENDING-EXACTLY-ONCE"],
    );
    first.child.kill("SIGKILL");
    await first.exit;
    await client.close();
    client = undefined;
    const second = await startHost();
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "recovery",
    });
    await client.request("hello");
    await client.request("session.resume", { sessionId: session.id });
    const recovered = (await client.request("execution.read", {
      sessionId: session.id,
      kind: "queue",
    })) as { state: string }[];
    expect(recovered[0]!.state).toContain("confirmation required");
    second.child.kill("SIGTERM");
    await second.exit;
    expect((await store.pendingPrompts(session.id)).map((q) => q.text)).toEqual(
      ["RECOVER-PENDING-EXACTLY-ONCE"],
    );
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
    // A key sent right after a lone Escape can be decoded with it as Alt+key, and
    // overlay repaints still show the editor footer. Leave Escape time to resolve.
    let escapedAt = 0;
    const send = async (text: string) => {
      const pause = escapedAt + 150 - Date.now();
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      const offset = output.length;
      terminal!.write(text);
      if (text === "\x1b") escapedAt = Date.now();
      return offset;
    };
    let step = 0;
    const wait = async (text: string, sent: number | Promise<number> = 0) => {
      const offset = await sent;
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
    const keys = workbenchKeys(send, wait, () => output);
    await keys.tab("Activity");
    await keys.object(
      "RECOVER-PENDING",
      "RECOVER-PENDING",
      "Resume recovered message",
    );
    expect(await store.messages(session.id)).toEqual([]);
    await keys.cancel(
      "2",
      "Resume recovered message",
      "Resume recovered message",
    );
    await keys.tab("Conversation");
    // Merely reading or default-cancelling recovery never dispatches a task.
    client = await SharedHostClient.connect({ home, cwd, clientId: "probe" });
    await client.request("hello");
    expect(await store.messages(session.id)).toEqual([]);
    await keys.tab("Activity");
    await keys.object(
      "RECOVER-PENDING",
      "RECOVER-PENDING",
      "Resume recovered message",
    );
    await wait("This permits the recovered message", send("2"));
    await send("\x1b[B\r");
    await vi.waitFor(async () =>
      expect(
        (await store.messages(session.id)).some((m) => m.role === "assistant"),
      ).toBe(true),
    );
    await keys.tab("Conversation");
    await wait("You wrote:");
    expect(
      (await store.messages(session.id))
        .filter((m) => m.role === "user")
        .map((m) => m.text),
    ).toEqual(["RECOVER-PENDING-EXACTLY-ONCE"]);
    expect(await store.pendingPrompts(session.id)).toEqual([]);
    await send("\x04");
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
