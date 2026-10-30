import { readFile, readdir, rm, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

// Recorded from the official npm tarball after checking its SHA-512 integrity.
// Updates require reviewing upstream changes and regenerating the full manifest.
export const forgeProof = JSON.parse(
  await readFile(
    new URL("./security/node-forge-1.4.2.json", import.meta.url),
    "utf8",
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyForge(root, { distribution = false } = {}) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (forgeProof.omittedDirectories.includes(entry.name)) {
      assert.ok(
        !distribution && entry.isDirectory(),
        "Unexpected browser/Flash distribution present",
      );
      continue;
    }
    if (entry.name === "lib") {
      assert.ok(entry.isDirectory(), "Non-directory forge lib");
      for (const file of await readdir(join(root, "lib")))
        files.push(`lib/${file}`);
    } else files.push(entry.name);
  }
  assert.deepEqual(
    files.sort(),
    Object.keys(forgeProof.files).sort(),
    "Unexpected forge file set",
  );
  for (const [file, expected] of Object.entries(forgeProof.files)) {
    const path = join(root, file);
    assert.ok((await lstat(path)).isFile(), `Non-regular forge file: ${file}`);
    assert.equal(
      hash(await readFile(path)),
      expected,
      `Forge release mismatch: ${file}`,
    );
  }
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, "node-forge");
  assert.equal(metadata.version, forgeProof.version);
  assert.equal(metadata.main, "lib/index.js");
  assert.equal(metadata.exports, undefined);
  return {
    version: metadata.version,
    integrity: forgeProof.integrity,
    rsaSha256: forgeProof.files["lib/rsa.js"],
    verifiedNodeFiles: files.filter((file) => file.startsWith("lib/")).length,
  };
}

/** Validate unmodified upstream code before omitting unused non-Node executables. */
export async function prepareForgeDistribution(root) {
  await verifyForge(root);
  for (const directory of forgeProof.omittedDirectories)
    await rm(join(root, directory), { recursive: true, force: true });
  return verifyForge(root, { distribution: true });
}

/** No nested copies, duplicate entries, or unreviewed code may enter a release. */
export function verifyForgeArchiveEntries(entries) {
  const forgeEntries = entries.filter((entry) =>
    /(?:^|\/)node-forge(?:\/|$)/.test(entry),
  );
  const expected = Object.keys(forgeProof.files).map(
    (file) => `package/node_modules/node-forge/${file}`,
  );
  assert.equal(
    new Set(forgeEntries).size,
    forgeEntries.length,
    "Duplicate forge archive entries",
  );
  assert.deepEqual(
    forgeEntries.sort(),
    expected.sort(),
    "Unexpected forge archive entries",
  );
}

export function verifyForgeLock(lock) {
  const entries = Object.entries(lock.packages ?? {}).filter(([path]) =>
    /(?:^|\/)node_modules\/node-forge$/.test(path),
  );
  assert.equal(entries.length, 1, "Expected one locked forge implementation");
  const [path, metadata] = entries[0];
  assert.equal(
    path,
    "node_modules/node-forge",
    "Unexpected nested forge lock entry",
  );
  assert.equal(metadata.version, forgeProof.version);
  assert.equal(metadata.resolved, forgeProof.tarball);
  assert.equal(metadata.integrity, forgeProof.integrity);
}
