import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { updateTextFile } from "../packages/tools/src/workspace.ts";

it("rejects a simultaneous update from another process and releases its lock afterward", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-file-lock-")),
  );
  const path = join(root, "source.txt");
  const release = join(root, "release");
  await writeFile(path, "V1", { mode: 0o640 });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { updateTextFile } from ${JSON.stringify(resolve("packages/tools/src/workspace.ts"))};
    import { existsSync } from 'node:fs';
    await updateTextFile(process.argv[1], new AbortController().signal, (current) => {
      process.stdout.write('locked\\n');
      const until = Date.now() + 10000;
      while (!existsSync(process.argv[2]) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return current + '-A';
    });
  `,
      path,
      release,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child.stdout, "data").then(([data]) => String(data)),
      exited.then(([code]) => {
        throw Error(`Writer exited before lock (${code})`);
      }),
    ]);
    expect(ready).toContain("locked");
    await expect(
      updateTextFile(path, new AbortController().signal, () => "V1-B"),
    ).rejects.toThrow("File update locked");
    await writeFile(release, "go");
    expect((await exited)[0]).toBe(0);
    expect(await readFile(path, "utf8")).toBe("V1-A");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    await updateTextFile(
      path,
      new AbortController().signal,
      (current) => current + "-B",
    );
    expect(await readFile(path, "utf8")).toBe("V1-A-B");
    await expect(stat(path + ".hikaro-lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await writeFile(release, "go");
    child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("preserves the file and releases the lock when replacement fails or is cancelled", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-file-failure-")),
  );
  const path = join(root, "source.txt");
  await writeFile(path, "original");
  try {
    const controller = new AbortController();
    await expect(
      updateTextFile(path, controller.signal, () => {
        controller.abort();
        return "cancelled";
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    await expect(stat(path + ".hikaro-lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await updateTextFile(path, new AbortController().signal, () => "next");
    expect(await readFile(path, "utf8")).toBe("next");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
