import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it.each([false, true])(
  "searches and reads full messages in TUI (attached=%s)",
  async (attached) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-search-pty-")),
    );
    const cwd = join(home, "workspace");
    await mkdir(cwd);
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    let host: ReturnType<typeof spawnProcess> | undefined;
    let hostExit: Promise<unknown> | undefined;
    let terminal: ReturnType<typeof spawn> | undefined;
    let terminalExit: Promise<number> | undefined;
    const args = [
      resolve(process.env.HIKARO_TEST_BIN ?? "dist/hikaro.mjs"),
      "--home",
      home,
      "--cwd",
      cwd,
    ];
    try {
      const session = await store.createSession(
        cwd,
        "Search fixture",
        undefined,
        {
          provider: "demo",
          model: "offline",
          settings: {},
        },
      );
      await store.append(session.id, "message", {
        message: {
          role: "user",
          text:
            "ORIGINAL-BEGIN\n" +
            "ordinary line\n".repeat(1700) +
            "FULLTEXT-NEEDLE",
          timestamp: 1,
          images: [
            {
              mimeType: "image/png",
              data: Buffer.alloc(100003, 73).toString("base64"),
            },
          ],
        },
      });
      if (attached) {
        host = spawnProcess(process.execPath, [...args, "--host", "--demo"]);
        hostExit = new Promise((done) => host!.once("exit", done));
        let output = "";
        host.stdout!.on("data", (data) => (output += data));
        host.stderr!.on("data", (data) => (output += data));
        await vi.waitFor(() => expect(output).toContain("shared host ready"), {
          timeout: 10000,
        });
        const client = await SharedHostClient.connect({
          home,
          cwd,
          clientId: "export-check",
        });
        try {
          await client.request("hello");
          await client.request("session.resume", { sessionId: session.id });
          const exported = (await client.request("session.export.file", {
            sessionId: session.id,
          })) as { path: string };
          const markdown = await readFile(exported.path, "utf8");
          const relative = markdown.match(/!\[Image 1\]\(([^)]+)\)/)![1]!;
          expect(relative.startsWith("/")).toBe(false);
          expect(
            await readFile(join(dirname(exported.path), relative)),
          ).toEqual(Buffer.alloc(100003, 73));
        } finally {
          await client.close();
        }
      }
      let output = "";
      terminal = spawn(
        process.execPath,
        [
          ...args,
          "--session",
          session.id,
          ...(attached ? ["--attach"] : ["--demo"]),
        ],
        {
          cols: 110,
          rows: 38,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      terminal.onData((data) => (output += data));
      terminalExit = new Promise((done) =>
        terminal!.onExit(({ exitCode }) => done(exitCode)),
      );
      const wait = (text: string, offset = 0) =>
        vi.waitFor(
          () =>
            expect(stripVTControlCharacters(output.slice(offset))).toContain(
              text,
            ),
          { timeout: 10000 },
        );
      const send = (text: string) => {
        const offset = output.length;
        terminal!.write(text);
        return offset;
      };
      await wait("Enter send");
      await wait("Search: FULLTEXT-NEEDLE", send("/search FULLTEXT-NEEDLE\r"));
      await wait("FULLTEXT-NEEDLE");
      await wait("ORIGINAL-BEGIN", send("\r"));
      await wait("Next section");
      await wait("section 2", send("\x1b[B\r"));
      await wait("FULLTEXT-NEEDLE", send("\x1b[F"));
      await wait("Search: FULLTEXT-NEEDLE", send("\x1b"));
      await wait("Enter send", send("\x1b"));
      send("\x04");
      expect(await terminalExit).toBe(0);
    } finally {
      terminal?.kill();
      await terminalExit;
      host?.kill("SIGTERM");
      await hostExit;
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  35000,
);
