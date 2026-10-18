import { afterEach, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readFileBytesBatch,
  SecureFileError,
} from "../packages/tools/src/secure-files.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-file-batch-")),
  );
  directories.push(root);
  const path = join(root, "SKILL.md");
  await writeFile(path, "description: 中文🙂\n\0safe");
  return { root, path };
}
const pathFrame = (path: string) => {
  const bytes = Buffer.from(path);
  return Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes]);
};

it("preserves file ordering and isolates missing, symlink, FIFO and oversized entries", async () => {
  const { root, path } = await fixture();
  const link = join(root, "link");
  const fifo = join(root, "fifo");
  const large = join(root, "large");
  await symlink(path, link);
  execFileSync("mkfifo", [fifo]);
  await writeFile(large, Buffer.alloc(2_000_001));
  const results: PromiseSettledResult<Buffer>[] = [];
  await readFileBytesBatch(
    [path, join(root, "missing"), link, fifo, large, path],
    AbortSignal.timeout(10000),
    (result) => results.push(result),
  );
  const text = await readFile(path);
  expect(results).toHaveLength(6);
  expect(results[0]).toEqual({ status: "fulfilled", value: text });
  expect(results[5]).toEqual({ status: "fulfilled", value: text });
  for (const index of [1, 2, 3, 4]) {
    expect(results[index]).toMatchObject({ status: "rejected" });
    expect((results[index] as PromiseRejectedResult).reason).toBeInstanceOf(
      SecureFileError,
    );
  }
  expect((results[1] as PromiseRejectedResult).reason.errno).toBe(
    constants.errno.ENOENT,
  );
  expect((results[4] as PromiseRejectedResult).reason.errno).toBe(
    constants.errno.EFBIG,
  );
});

it("refuses a canonical leaf swapped for a symlink between batch reads", async () => {
  const { root, path } = await fixture();
  const changed = join(root, "changed");
  const target = join(root, "private-target");
  await writeFile(changed, "authorized before opening");
  await writeFile(target, "MUST_NOT_BE_DISCLOSED");
  const child = spawn(
    resolve("packages/tools/src/secure-file-helper"),
    ["read-many", "2", "2000000"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on("error", () => {});
  try {
    const firstResponse = once(child.stdout, "data");
    child.stdin.write(pathFrame(path));
    await firstResponse;
    await unlink(changed);
    await symlink(target, changed);
    child.stdin.end(pathFrame(changed));
    expect((await closed)[0]).toBe(0);
    const output = Buffer.concat(chunks);
    const newline = output.indexOf(10);
    const header = JSON.parse(output.subarray(0, newline).toString("utf8"));
    expect(output.subarray(newline + 1, newline + 1 + header.length)).toEqual(
      await readFile(path),
    );
    const failure = JSON.parse(
      output.subarray(newline + 1 + header.length).toString("utf8"),
    );
    expect(failure).toMatchObject({
      error: expect.any(String),
      errno: constants.errno.ELOOP,
    });
    expect(output.toString("utf8")).not.toContain("MUST_NOT_BE_DISCLOSED");
    expect(await readFile(target, "utf8")).toBe("MUST_NOT_BE_DISCLOSED");
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});

it("cancels between entries and rejects unbounded or noncanonical batches", async () => {
  const { path } = await fixture();
  const controller = new AbortController();
  const delivered: number[] = [];
  await expect(
    readFileBytesBatch([path, path], controller.signal, (_result, index) => {
      delivered.push(index);
      controller.abort();
    }),
  ).rejects.toThrow(/abort/i);
  expect(delivered).toEqual([0]);
  await expect(
    readFileBytesBatch(
      Array(101).fill(path),
      AbortSignal.timeout(10000),
      () => {},
    ),
  ).rejects.toThrow(/100|capacity|batch/i);
  await expect(
    readFileBytesBatch(
      ["relative/SKILL.md"],
      AbortSignal.timeout(10000),
      () => {},
    ),
  ).rejects.toThrow(/invalid|canonical/i);
  await expect(
    readFileBytesBatch([path], AbortSignal.timeout(10000), () => {}, 2_000_001),
  ).rejects.toThrow(/invalid|limit|capacity/i);
});
