import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { assessAudit } from "./release-audit.mjs";
import {
  verifyForge,
  prepareForgeDistribution,
  verifyForgeArchiveEntries,
  verifyForgeLock,
  forgeProof,
} from "./forge-release.mjs";

async function fixture(t) {
  const require = createRequire(import.meta.url);
  const runtime = createRequire(
    require.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const source = dirname(runtime.resolve("node-forge/package.json"));
  const directory = await mkdtemp(join(tmpdir(), "hikaro-forge-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "node-forge");
  await cp(source, root, { recursive: true });
  return { root, source };
}

test("official release proof covers the actual installed Node implementation and distribution", async (t) => {
  const { root, source } = await fixture(t);
  assert.equal((await verifyForge(source)).version, "1.4.2");
  await assert.rejects(
    verifyForge(root, { distribution: true }),
    /browser\/Flash/,
  );
  const result = await prepareForgeDistribution(root);
  assert.equal(result.verifiedNodeFiles, 49);
  assert.equal(result.integrity, forgeProof.integrity);
  assert.equal(result.rsaSha256, forgeProof.files["lib/rsa.js"]);
  for (const path of ["dist", "flash"])
    await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
});

test("release proof rejects missing, altered, extra, redirected and non-regular code", async (t) => {
  const { root } = await fixture(t);
  const rsa = join(root, "lib/rsa.js");
  const original = await readFile(rsa);
  await writeFile(rsa, "module.exports = {};\n");
  await assert.rejects(verifyForge(root), /release mismatch/);
  await rm(rsa);
  await assert.rejects(verifyForge(root), /file set/);
  await writeFile(rsa, original);
  await writeFile(join(root, "lib/extra.js"), "extra code");
  await assert.rejects(verifyForge(root), /file set/);
  await rm(join(root, "lib/extra.js"));
  await writeFile(join(root, "extra.js"), "extra entry");
  await assert.rejects(verifyForge(root), /file set/);
  await rm(join(root, "extra.js"));
  const metadata = await readFile(join(root, "package.json"), "utf8");
  await writeFile(
    join(root, "package.json"),
    metadata.replace('"lib/index.js"', '"lib/forge.js"'),
  );
  await assert.rejects(verifyForge(root), /release mismatch/);
  await writeFile(join(root, "package.json"), metadata);
  await rm(rsa);
  await symlink("index.js", rsa);
  await assert.rejects(verifyForge(root), /Non-regular/);
  await rm(rsa);
  await mkdir(rsa);
  await assert.rejects(verifyForge(root), /Non-regular/);
});

test("forge archive admits exactly one complete official Node file set", () => {
  const entries = Object.keys(forgeProof.files).map(
    (file) => `package/node_modules/node-forge/${file}`,
  );
  verifyForgeArchiveEntries(["package/package.json", ...entries]);
  assert.throws(
    () => verifyForgeArchiveEntries(entries.slice(1)),
    /Unexpected/,
  );
  assert.throws(
    () => verifyForgeArchiveEntries([...entries, entries[0]]),
    /Duplicate/,
  );
  for (const extra of [
    "package/node_modules/node-forge",
    "package/node_modules/node-forge/dist/forge.min.js",
    "package/node_modules/node-forge/lib/extra.js",
    "package/node_modules/another/node_modules/node-forge/lib/rsa.js",
  ])
    assert.throws(
      () => verifyForgeArchiveEntries([...entries, extra]),
      /Unexpected/,
    );
});

test("production lock must identify the reviewed official tarball exactly once", () => {
  const lock = {
    packages: {
      "node_modules/node-forge": {
        version: forgeProof.version,
        resolved: forgeProof.tarball,
        integrity: forgeProof.integrity,
      },
    },
  };
  verifyForgeLock(lock);
  for (const field of ["version", "resolved", "integrity"]) {
    const changed = structuredClone(lock);
    changed.packages["node_modules/node-forge"][field] = "unreviewed";
    assert.throws(() => verifyForgeLock(changed));
  }
  assert.throws(() => verifyForgeLock({ packages: {} }), /one locked/);
  const duplicate = structuredClone(lock);
  duplicate.packages["node_modules/other/node_modules/node-forge"] =
    duplicate.packages["node_modules/node-forge"];
  assert.throws(() => verifyForgeLock(duplicate), /one locked/);
});

test("the former forge advisory no longer has an audit exception", () => {
  const result = assessAudit({
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
    vulnerabilities: {
      "node-forge": {
        severity: "high",
        via: [{ url: "https://github.com/advisories/GHSA-86w9-cpqp-85rv" }],
      },
    },
  });
  assert.equal(result.passed, false);
});
