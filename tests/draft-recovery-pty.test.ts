import { it, expect, vi } from "vitest";
import { spawn } from "node-pty";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("recovers crash and Ctrl+D drafts with --continue and clears only after submission in the real TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-crash-draft-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await store.createSession(cwd, "Recovery", undefined, {
    provider: "demo",
    model: "offline",
    settings: {},
  });
  const children: ReturnType<typeof start>[] = [];
  function start(resume = false) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("packages/cli/src/index.ts"),
        "--demo",
        "--home",
        home,
        "--cwd",
        cwd,
        ...(resume ? ["--continue"] : ["--session", session.id]),
      ],
      { cols: 100, rows: 24, env: { ...process.env, TERM: "xterm-256color" } },
    );
    let output = "",
      exited = false;
    child.onData((data) => {
      output = (output + data).slice(-100000);
    });
    const exit = new Promise<number>((done) =>
      child.onExit(({ exitCode }) => {
        exited = true;
        done(exitCode);
      }),
    );
    return {
      child,
      exit,
      get exited() {
        return exited;
      },
      screen: () => output,
    };
  }
  try {
    const first = start();
    children.push(first);
    await vi.waitFor(() => expect(first.screen()).toContain("/help"), {
      timeout: 10000,
    });
    const text = "恢复草稿-CRASH-RECOVERY";
    first.child.write(text);
    await vi.waitFor(
      async () => expect(await store.draft(session.id)).toBe(text),
      { timeout: 5000 },
    );
    first.child.kill("SIGKILL");
    await first.exit;
    const second = start(true);
    children.push(second);
    await vi.waitFor(() => expect(second.screen()).toContain(text), {
      timeout: 10000,
    });
    const appended = " 即刻退出😀";
    // Exit in the same input batch, without waiting for the autosave timer.
    second.child.write("\x1b[200~" + appended + "\x1b[201~\x04");
    await vi.waitFor(() => expect(second.exited).toBe(true), { timeout: 5000 });
    expect(await second.exit).toBe(0);
    expect(await store.draft(session.id)).toBe(text + appended);
    expect(
      (await store.messages(session.id)).filter(
        (message) => message.role === "user",
      ),
    ).toEqual([]);
    const third = start(true);
    children.push(third);
    await vi.waitFor(() => expect(third.screen()).toContain(text + appended), {
      timeout: 10000,
    });
    third.child.write("\r");
    await vi.waitFor(
      async () => {
        expect(
          (await store.messages(session.id))
            .filter((message) => message.role === "user")
            .map((message) => message.text),
        ).toEqual([text + appended]);
        expect(await store.draft(session.id)).toBe("");
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(third.screen()).toContain("You wrote:"), {
      timeout: 5000,
    });
    third.child.write("\x04");
    expect(await third.exit).toBe(0);
    expect(await store.draft(session.id)).toBe("");
  } finally {
    for (const child of children)
      if (!child.exited) child.child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exit));
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
