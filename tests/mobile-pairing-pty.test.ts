import { it, expect, vi } from "vitest";
import { spawn } from "node-pty";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { Runtime } from "../packages/runtime/src/index.ts";
for (const managed of [false, true])
  it(`${managed ? "managed" : "local"} TUI pairs and cancels in one terminal without losing the current session`, async () => {
    const home = await realpath(
        await mkdtemp(join(tmpdir(), "hikaro-pair-pty-")),
      ),
      cwd = join(home, "workspace");
    await mkdir(cwd);
    const seed = await Runtime.open({
      home,
      cwd,
      demo: true,
      approve: async () => false,
    });
    const session = await seed.session();
    await seed.store.rememberSession(session.id);
    await seed.close();
    let args = [
      "--import",
      "tsx",
      resolve("apps/cli/src/index.ts"),
      "--demo",
      "--home",
      home,
      "--cwd",
      cwd,
    ];
    if (managed) {
      const script = join(home, "managed.mts");
      await writeFile(
        script,
        `import {openMobileTui} from ${JSON.stringify(pathToFileURL(resolve("apps/cli/src/mobile-tui.ts")).href)};await openMobileTui(${JSON.stringify({ home, cwd, demo: true, session: session.id })});`,
      );
      args = ["--import", "tsx", script];
    }
    const term = spawn(process.execPath, args, {
      name: "xterm-256color",
      cols: 110,
      rows: 45,
      cwd: resolve("."),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    let output = "";
    term.onData((data) => {
      output += stripVTControlCharacters(data);
    });
    const exited = new Promise<number>((done) =>
      term.onExit((e) => done(e.exitCode)),
    );
    const wait = async (text: string) =>
      vi.waitFor(() => expect(output).toContain(text), { timeout: 10000 });
    let probe: SharedHostClient | undefined;
    try {
      await wait(managed ? "手机接续已就绪" : "Type a task");
      output = "";
      term.write("/pair\r");
      await wait("输入已部署的 relay 地址");
      // A cancelled first-time setup never starts a second runtime.
      if (!managed)
        await expect(SharedHostClient.connect({ home, cwd })).rejects.toThrow(
          "Shared host unavailable",
        );
      term.write("\x1b");
      await new Promise((r) => setTimeout(r, 100));
      output = "";
      term.write("/pair\r");
      await wait("输入已部署的 relay 地址");
      term.write("wss://relay.example\r");
      await wait("隐藏输入");
      output = "";
      term.write("secret-not-visible");
      await new Promise((r) => setTimeout(r, 100));
      expect(output).not.toContain("secret-not-visible");
      term.write("\x1b");
      await new Promise((r) => setTimeout(r, 100));
      if (managed) {
        probe = await SharedHostClient.connect({
          home,
          cwd,
          clientId: "pair-test",
        });
        await probe.request("hello");
        const rows = await probe.request("session.list");
        expect(JSON.stringify(rows)).toContain(session.id);
        await probe.close();
        probe = undefined;
      }
      term.write("\x04");
      expect(
        await Promise.race([
          exited,
          new Promise((r) => setTimeout(() => r("timeout"), 10000)),
        ]),
      ).toBe(0);
      await expect(SharedHostClient.connect({ home, cwd })).rejects.toThrow(
        "Shared host unavailable",
      );
    } finally {
      await probe?.close();
      try {
        term.kill();
      } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
