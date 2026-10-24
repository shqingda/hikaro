import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkFingerprint } from "./bench-support.mjs";

test("benchmark identity changes when the native process probe changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hikaro-fingerprint-"));
  try {
    await writeFile(join(directory, "hikaro.mjs"), "export const version = 1;");
    await writeFile(join(directory, "secure-file-helper"), "file helper");
    await writeFile(join(directory, "process-snapshot-helper"), "probe v1");
    const before = await benchmarkFingerprint(directory);
    await writeFile(join(directory, "process-snapshot-helper"), "probe v2");
    const after = await benchmarkFingerprint(directory);
    assert.notEqual(before.bundleSha256, after.bundleSha256);
    assert.notEqual(
      before.bundleFiles["process-snapshot-helper"],
      after.bundleFiles["process-snapshot-helper"],
    );
    assert.equal(
      before.bundleFiles["hikaro.mjs"],
      after.bundleFiles["hikaro.mjs"],
    );
    await writeFile(join(directory, "hikaro.mjs.map"), "debugging metadata");
    assert.deepEqual(await benchmarkFingerprint(directory), after);
    await rm(join(directory, "process-snapshot-helper"));
    await assert.rejects(benchmarkFingerprint(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
