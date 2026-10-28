import { readFile, readdir, writeFile, rm, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

export const forgeProof = JSON.parse(
  await readFile(
    new URL("../patches/node-forge-1.4.0.json", import.meta.url),
    "utf8",
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// This verifies the complete Node implementation, not just a version string.
export async function verifyForge(root, { distribution = false } = {}) {
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, "node-forge");
  assert.equal(metadata.version, forgeProof.version);
  assert.equal(metadata.main, "lib/index.js");
  assert.equal(metadata.exports, undefined);
  assert.deepEqual(
    (await readdir(join(root, "lib"))).sort(),
    Object.keys(forgeProof.files).sort(),
  );
  for (const [file, expected] of Object.entries(forgeProof.files)) {
    const path = join(root, "lib", file);
    assert.ok((await lstat(path)).isFile(), `Non-regular forge file: ${file}`);
    assert.equal(
      hash(await readFile(path)),
      expected,
      `Forge patch mismatch: ${file}`,
    );
  }
  if (distribution) {
    const entries = await readdir(root);
    assert.ok(
      !entries.includes("dist") && !entries.includes("flash"),
      "Unpatched browser/Flash distribution present",
    );
  }
  return {
    version: metadata.version,
    rsaSha256: forgeProof.files["rsa.js"],
    verifiedNodeFiles: Object.keys(forgeProof.files).length,
  };
}

export async function patchForge(root) {
  const path = join(root, "lib/rsa.js");
  const original = await readFile(path, "utf8");
  assert.equal(
    hash(original),
    forgeProof.originalRsaSha256,
    "Unexpected upstream forge source; reassess backport",
  );
  const patched = original.replace(
    "obj.value.length !== 2) {",
    "obj.value.length !== 2 ||\n            obj.value[0].value.length !== (('parameters' in capture) ? 2 : 1)) {",
  );
  assert.equal(hash(patched), forgeProof.files["rsa.js"]);
  await writeFile(path, patched);
  // This is a Node-only TUI distribution. Do not ship old browser executables.
  await rm(join(root, "dist"), { recursive: true, force: true });
  await rm(join(root, "flash"), { recursive: true, force: true });
  return verifyForge(root, { distribution: true });
}

// Keep the registry audit intact. A known finding is remediated only when every
// location reported by npm contains the exact reviewed implementation.
export async function assessPatchedAudit(audit, directory) {
  if (audit.passed) return { ...audit, registryPassed: true, remediations: [] };
  const findings = Object.entries(audit.result.vulnerabilities ?? {}).filter(
    ([, value]) => ["high", "critical"].includes(value.severity),
  );
  const rejected = { ...audit, registryPassed: false, remediations: [] };
  if (
    audit.vulnerabilities.critical !== 0 ||
    findings.length !== audit.vulnerabilities.high ||
    ![1, 2].includes(findings.length) ||
    findings.some(
      ([name]) =>
        !["node-forge", "@anthropic-ai/sandbox-runtime"].includes(name),
    )
  )
    return rejected;
  const entries = Object.fromEntries(findings);
  const forge = entries["node-forge"];
  const runtime = entries["@anthropic-ai/sandbox-runtime"];
  if (
    !forge ||
    forge.via?.length !== 1 ||
    forge.via[0]?.url !== forgeProof.advisory ||
    (runtime &&
      (runtime.via?.length !== 1 || runtime.via[0] !== "node-forge")) ||
    !forge.nodes?.length
  )
    return rejected;
  const locations = [];
  for (const node of forge.nodes) {
    assert.match(node, /^node_modules\/(?:[\w@.-]+\/)*node-forge$/);
    assert.ok(!node.split("/").includes(".."));
    locations.push({
      path: node,
      ...(await verifyForge(join(directory, node), { distribution: true })),
    });
  }
  return {
    ...audit,
    passed: true,
    registryPassed: false,
    remediations: [
      {
        advisory: forgeProof.advisory,
        method: "verified source backport",
        locations,
      },
    ],
  };
}
