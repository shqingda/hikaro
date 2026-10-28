import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const { scripts } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function run(command, fail = "") {
  assert.equal(
    typeof command,
    "string",
    "public preflight/build command must exist",
  );
  const dir = await mkdtemp(join(tmpdir(), "hikaro-preflight-"));
  try {
    for (const bin of ["pnpm", "bash", "node"]) {
      await writeFile(
        join(dir, bin),
        '#!/bin/sh\nprintf "%s\\n" "$(basename "$0") $*" >> "$TRACE"\n[ "$*" != "$FAIL" ]\n',
        { mode: 0o755 },
      );
    }
    const trace = join(dir, "trace");
    const result = spawnSync("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        TRACE: trace,
        FAIL: fail,
      },
    });
    return {
      status: result.status,
      commands: (await readFile(trace, "utf8")).trim().split("\n"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("local CI covers root, mobile and relay without deploying", async () => {
  const result = await run(scripts["ci:check"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, [
    "pnpm check",
    "pnpm mobile:typecheck",
    "pnpm check:relay",
    "pnpm --filter @hikaro/relay build",
  ]);
});
test("a failed local check prevents subsequent checks", async () => {
  const result = await run(scripts["ci:check"], "mobile:typecheck");
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.commands, ["pnpm check", "pnpm mobile:typecheck"]);
});
for (const name of ["build:android:release", "release:pack", "release:cli"]) {
  test(`${name} never packages after a failed preflight`, async () => {
    const result = await run(scripts[name], "ci:check");
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.commands, ["pnpm ci:check"]);
  });
}
