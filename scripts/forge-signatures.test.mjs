import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkForgeSignatures } from "./forge-signatures.mjs";

test("installed forge accepts valid signatures and rejects nested and noncanonical DER", () => {
  const require = createRequire(import.meta.url);
  const runtime = createRequire(
    require.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const report = checkForgeSignatures(runtime("node-forge"));
  assert.equal(report.cases.length, 8);
  assert.deepEqual(report.canonicalEncodingRejected, [
    "nullWithContent",
    "nonMinimalLength",
    "nonCanonicalOid",
  ]);
  assert.equal(report.pemBufferAccepted, true);
});
