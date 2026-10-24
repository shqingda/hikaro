import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../packages/tools/src/process.ts";

it("finishes cancelling descendants even when the process leader exits first", async () => {
  const root = await mkdtemp(join(tmpdir(), "hikaro-process-cancel-"));
  const marker = join(root, "pid");
  const controller = new AbortController();
  const script = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const work = runProcess(
    "/bin/zsh",
    [
      "-f",
      "-c",
      `${quote(process.execPath)} -e ${quote(script)} >/dev/null 2>&1 & wait`,
    ],
    { cwd: root, signal: controller.signal },
  );
  let pid: number | undefined;
  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(marker, "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    controller.abort();
    const result = await work;
    expect(result.text).toContain("Cancelled");
    expect(result.data).toMatchObject({ cleanup: "confirmed" });
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid!, 0)).toThrow();
      },
      { timeout: 2500 },
    );
  } finally {
    controller.abort();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await work;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
