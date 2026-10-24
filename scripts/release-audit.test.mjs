import { test } from "node:test";
import assert from "node:assert/strict";
import { assessAudit } from "./release-audit.mjs";
test("release audit rejects high/critical and fails closed on missing evidence", () => {
  const metadata = {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  };
  assert.equal(assessAudit({ metadata }).passed, true);
  for (const severity of ["high", "critical"])
    assert.equal(
      assessAudit({
        metadata: {
          vulnerabilities: { ...metadata.vulnerabilities, [severity]: 1 },
        },
      }).passed,
      false,
    );
  assert.throws(() => assessAudit({ error: { message: "network error" } }));
  assert.throws(() =>
    assessAudit({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
  );
});
