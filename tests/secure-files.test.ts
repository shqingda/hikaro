import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir, constants } from "node:os";
import {
  readFileBytes,
  readTextFile,
  replaceTextFile,
} from "../packages/tools/src/secure-files.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-secure-files-")),
  );
  directories.push(root);
  const path = join(root, "source.txt");
  await writeFile(path, "original");
  return { root, path, signal: AbortSignal.timeout(10000) };
}

it("preserves byte framing for Unicode, newlines, NULs and multiple pipe chunks", async () => {
  const { path, signal } = await fixture();
  const text = "中🙂\n\0".repeat(40000);
  await replaceTextFile(path, signal, () => text);
  expect(await readFileBytes(path, signal)).toEqual(Buffer.from(text));
  expect(await readTextFile(path, signal)).toBe(text);
});

it("refuses final-component symlinks without reading or changing their target", async () => {
  const { root, path, signal } = await fixture();
  const link = join(root, "link.txt");
  await symlink(path, link);
  await expect(readTextFile(link, signal)).rejects.toThrow();
  await expect(replaceTextFile(link, signal, () => "unsafe")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("original");
  expect((await readdir(root)).sort()).toEqual(["link.txt", "source.txt"]);
});

it("rejects a FIFO immediately and reports the read capacity for oversized files", async () => {
  const { root, path, signal } = await fixture();
  const fifo = join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  await expect(readTextFile(fifo, signal)).rejects.toThrow();
  await expect(readTextFile(path, signal, 2)).rejects.toMatchObject({
    errno: constants.errno.EFBIG,
  });
});

it.each(["cancel", "reject"])(
  "cleans its staged file and lock after a %s at the commit checkpoint",
  async (reason) => {
    const { root, path } = await fixture();
    const controller = new AbortController();
    const work = replaceTextFile(
      path,
      controller.signal,
      () => "changed",
      async () => {
        if (reason === "cancel") controller.abort();
        else throw Error("Lease checkpoint failed");
      },
    );
    await expect(work).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["source.txt"]);
  },
);

it("refuses a leaf replaced after staging without following its new link", async () => {
  const { root, path, signal } = await fixture();
  const target = join(root, "other.txt");
  await writeFile(target, "untouched");
  await expect(
    replaceTextFile(
      path,
      signal,
      () => "unsafe",
      async () => {
        await unlink(path);
        await symlink(target, path);
      },
    ),
  ).rejects.toThrow(/changed during editing/);
  expect(await readFile(target, "utf8")).toBe("untouched");
  expect((await readdir(root)).sort()).toEqual(["other.txt", "source.txt"]);
});

it("cleans the lock when its caller closes the protocol without committing", async () => {
  const { root, path } = await fixture();
  const child = spawn(
    resolve("packages/tools/src/secure-file-helper"),
    ["update", path, "1000"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  child.stdin.on("error", () => {});
  try {
    await once(child.stdout, "data");
    child.stdin.end();
    child.stdout.resume();
    expect((await closed)[0]).toBe(1);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["source.txt"]);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
