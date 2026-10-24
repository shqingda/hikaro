import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../packages/core/src/types.ts";
import { runWorkspaceCommand } from "../packages/tools/src/process.ts";

it.skipIf(process.platform !== "darwin").each(["natural exit", "abort"])(
  "bounds inherited output after parent %s without stopping a detached child",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "hikaro-foreground-boundary-"));
    const marker = join(root, "child-pid");
    const exitMarker = join(root, "exit-parent");
    const script = `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(
        process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'inherit' }
      );
      child.unref();
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(exitMarker)})) process.exit(0);
      }, 25);
    `;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const controller = new AbortController();
    const kill = vi.spyOn(process, "kill");
    const work = runWorkspaceCommand(
      `exec ${quote(process.execPath)} -e ${quote(script)}`,
      {
        cwd: root,
        signal: controller.signal,
      } as ToolContext,
      { unrestricted: true, observe: true },
    );
    let pid: number | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(async () => {
        pid = Number(await readFile(marker, "utf8"));
        expect(pid).toBeGreaterThan(1);
      });
      // Keep the parent available across the one-second observation interval.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (outcome === "abort") controller.abort();
      else await writeFile(exitMarker, "");
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(Error("Inherited output did not settle within 8 seconds")),
            8000,
          );
        }),
      ]);
      expect(result.data).toMatchObject({
        outputIncomplete: true,
        processNote: expect.stringContaining(String(pid)),
      });
      if (outcome === "abort") {
        expect(result.data).toMatchObject({ cleanup: "confirmed" });
        expect(result.text).toContain("Cancelled");
      } else {
        expect(result.data).toMatchObject({ exitCode: 0 });
      }
      expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(
        kill.mock.calls.filter(
          ([target, signal]) => Math.abs(target) === pid && signal !== 0,
        ),
      ).toEqual([]);
    } finally {
      clearTimeout(deadline);
      kill.mockRestore();
      controller.abort();
      pid ||= Number(await readFile(marker, "utf8").catch(() => "0"));
      if (pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      // The detached child owns inherited pipe descriptors. Close those before
      // awaiting the old implementation, which otherwise waits indefinitely.
      await work;
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

it.skipIf(process.platform === "win32").each(["EPERM", "survives SIGKILL"])(
  "returns a bounded failed cleanup when the original group %s",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "hikaro-foreground-stop-"));
    const marker = join(root, "root-pid");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const controller = new AbortController();
    const originalKill = process.kill.bind(process);
    let pid: number | undefined;
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((target, signal) => {
        if (pid && target === -pid && signal !== 0) {
          if (failure === "EPERM")
            throw Object.assign(Error("Permission denied"), { code: "EPERM" });
          return true;
        }
        return originalKill(target, signal);
      });
    const work = runWorkspaceCommand(
      `exec ${quote(process.execPath)} -e ${quote(script)}`,
      { cwd: root, signal: controller.signal } as ToolContext,
      { unrestricted: true },
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(async () => {
        pid = Number(await readFile(marker, "utf8"));
        expect(pid).toBeGreaterThan(1);
      });
      controller.abort();
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("Failed stop did not settle within 8 seconds")),
            8000,
          );
        }),
      ]);
      expect(result).toMatchObject({
        isError: true,
        data: {
          cleanup: "failed",
          exitCode: null,
          stopError: expect.any(String),
        },
      });
      expect(() => originalKill(pid!, 0)).not.toThrow();
      const stopSignals = () =>
        kill.mock.calls
          .filter(([target, signal]) => target === -pid! && signal !== 0)
          .map(([, signal]) => signal);
      expect(stopSignals()).toEqual(
        failure === "EPERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
      );
      if (failure === "EPERM") {
        const [next] = await Promise.all([
          runWorkspaceCommand(
            "printf NEXT-COMMAND",
            { cwd: root, signal: new AbortController().signal } as ToolContext,
            { unrestricted: true },
          ),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
        expect(next.text).toContain("NEXT-COMMAND");
        expect(next.isError).toBe(false);
        expect(stopSignals()).toEqual(["SIGTERM"]);
      }
    } finally {
      clearTimeout(deadline);
      kill.mockRestore();
      controller.abort();
      pid ||= Number(await readFile(marker, "utf8").catch(() => "0"));
      if (pid > 1) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      await work;
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
