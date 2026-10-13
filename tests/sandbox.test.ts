import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../packages/tools/src/index.ts";
it.skipIf(process.platform !== "darwin")(
  "sandbox reads/writes workspace files and denies a sibling directory",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hikaro-sandbox-"));
    const workspace = join(root, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    await writeFile(join(root, "outside.txt"), "secret-test");
    const script = resolve("packages/tools/src/sandbox-runner.mjs");
    try {
      const ok = await runProcess(
        process.execPath,
        [script, "printf allowed > inside.txt; cat inside.txt"],
        { cwd: workspace, signal: AbortSignal.timeout(10000) },
      );
      expect(ok.text).toContain("allowed");
      expect(ok.isError).toBe(false);
      expect(await readFile(join(workspace, "inside.txt"), "utf8")).toBe(
        "allowed",
      );
      const denied = await runProcess(
        process.execPath,
        [script, `cat '${join(root, "outside.txt")}'`],
        { cwd: workspace, signal: AbortSignal.timeout(10000) },
      );
      expect(denied.text).not.toContain("secret-test");
      expect(denied.isError).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
