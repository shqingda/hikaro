import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { assessAudit } from "./release-audit.mjs";
import { verifyForge, assessPatchedAudit, forgeProof } from "./forge-patch.mjs";

test("backport evidence fails closed for unpatched, altered, extra-code and unrelated findings", async () => {
  const require = createRequire(import.meta.url);
  const runtime = createRequire(
    require.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const source = dirname(runtime.resolve("node-forge/package.json"));
  await verifyForge(source);
  const directory = await mkdtemp(join(tmpdir(), "hikaro-forge-test-"));
  const root = join(directory, "node_modules/node-forge");
  try {
    await cp(source, root, { recursive: true });
    await rm(join(root, "dist"), { recursive: true, force: true });
    await rm(join(root, "flash"), { recursive: true, force: true });
    const result = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 },
      },
      vulnerabilities: {
        "node-forge": {
          severity: "high",
          via: [{ url: forgeProof.advisory }],
          nodes: ["node_modules/node-forge"],
        },
        "@anthropic-ai/sandbox-runtime": {
          severity: "high",
          via: ["node-forge"],
        },
      },
    };
    const audit = () => ({ ...assessAudit(result), result });
    const good = await assessPatchedAudit(audit(), directory);
    assert.equal(good.passed, true);
    assert.equal(good.registryPassed, false);
    assert.equal(good.vulnerabilities.high, 2);
    result.vulnerabilities["node-forge"].via.push({
      url: "https://github.com/advisories/another",
    });
    assert.equal((await assessPatchedAudit(audit(), directory)).passed, false);
    result.vulnerabilities["node-forge"].via.pop();
    result.vulnerabilities["node-forge"].nodes.push(
      "node_modules/another/node_modules/node-forge",
    );
    await assert.rejects(assessPatchedAudit(audit(), directory), /ENOENT/);
    result.vulnerabilities["node-forge"].nodes.pop();
    result.metadata.vulnerabilities.high++;
    result.vulnerabilities.other = {
      severity: "high",
      via: ["another-advisory"],
    };
    assert.equal((await assessPatchedAudit(audit(), directory)).passed, false);
    result.metadata.vulnerabilities.high--;
    delete result.vulnerabilities.other;
    await mkdir(join(root, "dist"));
    await assert.rejects(assessPatchedAudit(audit(), directory), /browser/);
    await rm(join(root, "dist"), { recursive: true });
    const rsa = join(root, "lib/rsa.js");
    const patched = await readFile(rsa, "utf8");
    await writeFile(
      rsa,
      patched.replace(
        "obj.value.length !== 2 ||\n            obj.value[0].value.length !== (('parameters' in capture) ? 2 : 1)) {",
        "obj.value.length !== 2) {",
      ),
    );
    await assert.rejects(
      assessPatchedAudit(audit(), directory),
      /patch mismatch/,
    );
    await writeFile(rsa, patched);
    await writeFile(join(root, "lib/index.js"), "module.exports = {};");
    await assert.rejects(
      assessPatchedAudit(audit(), directory),
      /patch mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
