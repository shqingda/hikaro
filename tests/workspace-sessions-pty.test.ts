import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { serveSharedHost } from "../packages/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it.each(["native", "attached"])(
  "%s switches running sessions, retains drafts and defers background approval focus",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "hikaro-multisession-"));
    await mkdir(join(home, "workspace"));
    const cwd = await realpath(join(home, "workspace"));
    const gate = join(home, "continue");
    const slowCreate = join(home, "slow-create");
    const creating = join(home, "creating");
    await writeFile(
      join(home, "fixture.mjs"),
      `import { existsSync, writeFileSync } from "node:fs";
export default { id: "multi", apiVersion: 1, setup(host) {
  host.registerProvider("fixture", async () => {
    if (existsSync(${JSON.stringify(slowCreate)})) { writeFileSync(${JSON.stringify(creating)}, "creating"); await new Promise(r => setTimeout(r, 400)); }
    return ({ id: "fixture", model: "multi", contextWindow: 32000,
    async *stream({messages,signal}) {
      const last = messages.at(-1);
      if (last.role === "user" && last.text === "background") {
        while (!existsSync(${JSON.stringify(gate)})) { signal.throwIfAborted(); await new Promise(r => setTimeout(r, 15)); }
        yield {type:"done", message:{role:"assistant",text:"",timestamp:1,toolCalls:[{id:"write",name:"write_file",arguments:{path:${JSON.stringify(join(home, "approved.txt"))},content:"approved"}}]},usage:{input:0,output:0,cost:0}};
      } else yield {type:"done",message:{role:"assistant",text:"background finished",timestamp:1},usage:{input:0,output:0,cost:0}};
    }
  }); });
}};`,
    );
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ plugins: [{ path: "fixture.mjs", trusted: true }] }),
    );
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    const selection = { provider: "fixture", model: "multi", settings: {} };
    const first = await store.createSession(
      cwd,
      "First task",
      undefined,
      selection,
    );
    const second = await store.createSession(
      cwd,
      "Second task",
      undefined,
      selection,
    );
    const host =
      mode === "attached"
        ? await serveSharedHost({
            home,
            cwd,
            provider: "fixture",
            model: "multi",
          })
        : undefined;
    if (host) {
      const initial = await SharedHostClient.connect({
        home,
        cwd,
        clientId: "multi-test",
      });
      await initial.request("session.resume", { sessionId: first.id });
      await initial.close();
    }
    const launch = (selection?: string) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("packages/cli/src/index.ts"),
          "--home",
          home,
          "--cwd",
          cwd,
          ...(host ? [] : ["--provider", "fixture", "--model", "multi"]),
          ...(selection ? ["--session", selection] : []),
          ...(host ? ["--attach", "--client-id", "multi-test"] : []),
        ],
        {
          cols: 120,
          rows: 40,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
    let terminal = launch(first.id);
    let output = "",
      exited = false;
    const observe = () => {
      exited = false;
      terminal.onData((data) => {
        output = (output + stripVTControlCharacters(data)).slice(-300000);
      });
      return new Promise<number>((resolve) =>
        terminal.onExit(({ exitCode }) => {
          exited = true;
          resolve(exitCode);
        }),
      );
    };
    let done = observe();
    const wait = async (text: string, after = 0) => {
      await vi.waitFor(() => expect(output.slice(after)).toContain(text), {
        timeout: 8000,
      });
    };
    const switchTo = async (title: string) => {
      const mark = output.length;
      terminal.write("\x0f");
      await wait("Sessions", mark);
      const searched = output.length;
      terminal.write(title);
      await wait(`→ ${title}`, searched);
      await wait("Enter resume", searched);
      terminal.write("\r");
      await wait(`workspace · ${title}`, mark);
    };
    try {
      await wait("Enter send");
      terminal.write("background\r");
      await vi.waitFor(
        async () =>
          expect(
            (await store.events(first.id)).some(
              (event) => event.type === "run.start",
            ),
          ).toBe(true),
        { timeout: 8000 },
      );
      terminal.write(`/resume ${second.id}\r`);
      await wait("› Second task");
      terminal.write("second draft 中文");
      await wait("second draft 中文");
      const background = output.length;
      await writeFile(gate, "go");
      await wait("Needs attention  1", background);
      expect(output.slice(background)).not.toContain("Permission required");
      await expect(
        readFile(join(home, "approved.txt"), "utf8"),
      ).rejects.toThrow();
      if (host) {
        // Closing the terminal preserves every background scope's host approval.
        terminal.write("\x04");
        await vi.waitFor(() => expect(exited).toBe(true), { timeout: 8000 });
        expect(await done).toBe(0);
        const reopened = output.length;
        terminal = launch();
        done = observe();
        await wait("workspace · Second task", reopened);
        await wait("second draft 中文", reopened);
        await wait("Needs attention  1", reopened);
        expect(output.slice(reopened)).not.toContain("Permission required");
      }
      await switchTo("First task");
      await wait("Permission required", background);
      terminal.write("\x1b[A\r");
      await vi.waitFor(
        async () =>
          expect(await readFile(join(home, "approved.txt"), "utf8")).toBe(
            "approved",
          ),
        { timeout: 8000 },
      );
      await vi.waitFor(
        async () =>
          expect(
            (await store.events(first.id)).some(
              (event) => event.type === "run.end",
            ),
          ).toBe(true),
        { timeout: 8000 },
      );
      const returned = output.length;
      await switchTo("Second task");
      await wait("second draft 中文", returned);
      // The sole-session delete first prepares a replacement. Slow that factory
      // down while its old menu is still present, then exit through the workspace.
      const closed = output.length;
      terminal.write("\x15/close\r");
      await wait("workspace · First task", closed);
      await writeFile(slowCreate, "slow");
      const deleting = output.length;
      terminal.write("/sessions First task\r");
      await wait("Sessions · page 1", deleting);
      terminal.write("\x1b[3~");
      await wait("Delete “First task”?", deleting);
      terminal.write("\r");
      await vi.waitFor(
        async () => expect(await readFile(creating, "utf8")).toBe("creating"),
        { timeout: 8000 },
      );
      terminal.write("\x04");
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 8000 });
      expect(await done).toBe(0);
      expect(
        (await store.events(first.id)).filter(
          (event) => event.type === "run.start",
        ),
      ).toHaveLength(1);
      expect(
        (await store.messages(second.id)).filter(
          (message) => message.role === "user",
        ),
      ).toEqual([]);
    } finally {
      if (!exited) terminal.kill("SIGKILL");
      await done;
      await host?.close();
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);

it("exits successfully when Ctrl+D arrives with the first native frame", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-first-frame-exit-"));
  const terminal = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("packages/cli/src/index.ts"),
      "--demo",
      "--home",
      home,
    ],
    { cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" } },
  );
  let output = "",
    sent = false;
  terminal.onData((data) => {
    output += stripVTControlCharacters(data);
    if (!sent && output.includes("Enter send")) {
      sent = true;
      terminal.write("\x04");
    }
  });
  try {
    const result = await new Promise<number>((resolve) =>
      terminal.onExit(({ exitCode }) => resolve(exitCode)),
    );
    expect(result).toBe(0);
    expect(output).not.toContain("Runtime is closing");
  } finally {
    terminal.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
