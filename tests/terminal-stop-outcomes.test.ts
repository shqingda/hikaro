import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionItems } from "../packages/runtime/src/execution-items.ts";
import {
  PluginHost,
  ToolRegistry,
  type ToolContext,
} from "../packages/core/src/index.ts";
import {
  TerminalManager,
  terminalPlugin,
} from "../packages/tools/src/terminal.ts";

const probeFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execute = promisify(real.execFile);
  return {
    ...real,
    execFile: Object.defineProperty(
      real.execFile.bind(null),
      promisify.custom,
      {
        value: async (...args: Parameters<typeof execute>) => {
          if (
            probeFailure.enabled &&
            String(args[0]).endsWith("process-snapshot-helper")
          )
            throw Error("Injected probe failure");
          return execute(...args);
        },
      },
    ),
  };
});

it("confirms descendant termination even when the PTY leader exits first", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-terminal-stop-"));
  const marker = join(home, "child-pid");
  const script = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const manager = new TerminalManager(),
    tools = new ToolRegistry(),
    host = new PluginHost(tools);
  await host.load(terminalPlugin(true, () => true, manager));
  const ctx = {
    cwd: home,
    sessionId: "owner",
    signal: new AbortController().signal,
    approve: async () => true,
  } as unknown as ToolContext;
  let pid: number | undefined;
  try {
    const result = await tools.get("terminal_start")!.execute(
      {
        command: `${quote(process.execPath)} -e ${quote(script)} >/dev/null 2>&1 & wait`,
        cols: 80,
        rows: 24,
      },
      ctx,
    );
    const id = (result.data as { id: string }).id;
    await vi.waitFor(async () => {
      pid = Number(await readFile(marker, "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    manager.stop("owner", id);
    await vi.waitFor(
      () => expect(manager.detail("owner", id).state).toBe("exited"),
      { timeout: 5000 },
    );
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(manager.detail("owner", id).cleanup).toBe("confirmed");
    expect(manager.detail("owner", id).exitCode).toEqual(expect.any(Number));
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 10000);

it("reports a failed stop and allows retry without claiming exit", async () => {
  const manager = new TerminalManager();
  const tools = new ToolRegistry();
  const host = new PluginHost(tools);
  await host.load(terminalPlugin(true, () => true, manager));
  const ctx = {
    cwd: process.cwd(),
    sessionId: "owner",
    signal: new AbortController().signal,
    approve: async () => true,
  } as unknown as ToolContext;
  try {
    const result = await tools
      .get("terminal_start")!
      .execute({ command: "sleep 30", cols: 80, rows: 24 }, ctx);
    const id = (result.data as { id: string }).id;
    const pid = manager.find("owner", id).pty.pid;
    const kill = process.kill.bind(process);
    const spy = vi
      .spyOn(process, "kill")
      .mockImplementation((target, signal) => {
        if (target === -pid && signal === "SIGTERM")
          throw Object.assign(Error("Permission denied"), { code: "EPERM" });
        return kill(target, signal);
      });
    try {
      manager.stop("owner", id);
      await manager.find("owner", id).stopTask;
      expect(manager.detail("owner", id)).toMatchObject({
        state: "stop_failed",
        cleanup: "failed",
        stopError: "Permission denied",
      });
      const read = await tools.get("terminal_read")!.execute({ id }, ctx);
      expect(read.data).toMatchObject({ state: "stop_failed", running: true });
    } finally {
      spy.mockRestore();
    }
    manager.stop("owner", id);
    await manager.find("owner", id).stopTask;
    expect(manager.detail("owner", id)).toMatchObject({
      state: "exited",
      cleanup: "confirmed",
    });
  } finally {
    await host.close();
  }
});

it.skipIf(process.platform !== "darwin").each(["stop", "natural exit"])(
  "reports an observed detached child after PTY %s without signaling it",
  async (outcome) => {
    const home = await mkdtemp(join(tmpdir(), "hikaro-terminal-detached-"));
    const marker = join(home, "child-pid");
    const exitMarker = join(home, "exit-parent");
    const script = `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(
        process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(exitMarker)})) process.exit(0);
      }, 25);
    `;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const manager = new TerminalManager();
    const tools = new ToolRegistry();
    const host = new PluginHost(tools);
    await host.load(terminalPlugin(true, () => true, manager));
    const ctx = {
      cwd: home,
      sessionId: "owner",
      signal: new AbortController().signal,
      approve: async () => true,
    } as unknown as ToolContext;
    const kill = vi.spyOn(process, "kill");
    let pid: number | undefined;
    try {
      const result = await tools.get("terminal_start")!.execute(
        {
          command: `exec ${quote(process.execPath)} -e ${quote(script)}`,
          cols: 80,
          rows: 24,
        },
        ctx,
      );
      const id = (result.data as { id: string }).id;
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(marker, "utf8"));
          expect(pid).toBeGreaterThan(1);
          expect(manager.detail("owner", id)).toHaveProperty(
            "processNote",
            expect.stringContaining(String(pid)),
          );
        },
        { timeout: 5000 },
      );
      if (outcome === "stop") {
        manager.stop("owner", id);
        await manager.find("owner", id).stopTask;
      } else {
        await writeFile(exitMarker, "");
      }
      await vi.waitFor(
        () =>
          expect(manager.detail("owner", id)).toMatchObject({
            state: "descendants_running",
            exitCode: expect.any(Number),
            processNote: expect.stringContaining(String(pid)),
          }),
        { timeout: 5000 },
      );
      const actions = () =>
        executionItems(
          { pendingPrompts: () => [], pendingSteering: () => [] },
          {
            terminalList: (owner) =>
              manager.list(owner).map((row) => ({ ...row, restored: false })),
            childTasks: () => [],
          },
          "owner",
          "terminals",
        )[0]!.actions;
      expect(actions()).toEqual([]);
      if (outcome === "stop") {
        probeFailure.enabled = true;
        await manager.find("owner", id).processes.sample();
        const unknown = await tools.get("terminal_read")!.execute({ id }, ctx);
        expect(unknown.data).toMatchObject({
          state: "descendants_unknown",
          running: true,
        });
        expect(actions()).toEqual([]);
        probeFailure.enabled = false;
        await manager.find("owner", id).processes.sample();
        expect(manager.detail("owner", id).state).toBe("descendants_running");
      }
      expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(
        kill.mock.calls.filter(
          ([target, signal]) => Math.abs(target) === pid && signal !== 0,
        ),
      ).toEqual([]);
    } finally {
      probeFailure.enabled = false;
      kill.mockRestore();
      pid ??= Number(await readFile(marker, "utf8").catch(() => "0"));
      if (pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  15000,
);
