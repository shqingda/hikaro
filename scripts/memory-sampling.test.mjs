import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePss,
  createMemorySampler,
  assertSampleContinuity,
} from "./memory-sampling.mjs";
test("PSS uses proportional resident and swap accounting, not RSS", () => {
  assert.deepEqual(parsePss("Rss: 99999 kB\nPss: 2048 kB\nSwapPss: 512 kB\n"), {
    memoryMiB: 2,
    swapPssMiB: 0.5,
  });
  assert.throws(() => parsePss("Rss: 99999 kB"));
  assert.throws(() => parsePss("Pss: 1 kB\nPss: 2 kB\nSwapPss: 0 kB"));
});
test("sleep or long sampling gaps cannot count as a continuous soak", () => {
  const previous = { elapsedMs: 0, wallTimeMs: 100000 };
  assertSampleContinuity(previous, { elapsedMs: 20000, wallTimeMs: 120000 });
  assert.throws(() =>
    assertSampleContinuity(previous, { elapsedMs: 20000, wallTimeMs: 700000 }),
  );
  assert.throws(() =>
    assertSampleContinuity(previous, { elapsedMs: 600000, wallTimeMs: 700000 }),
  );
});
test("native sampler reads a live process and rejects invalid or exited PID", () => {
  const sampler = createMemorySampler();
  try {
    assert.ok(sampler.sample(process.pid).memoryMiB > 0);
    assert.throws(() => sampler.sample(-1));
    assert.throws(() => sampler.sample(2147483647));
  } finally {
    sampler.close();
  }
});

test("RSS diagnostics and slow startup only warn, while input violations still fail", async () => {
  const { STARTUP_BUDGETS, STARTUP_ADVISORY } = await import("./bench.mjs");
  const { SHARED_STARTUP_BUDGETS } = await import("./bench-shared-host.mjs");
  const { evaluateBudgets } = await import("./bench-support.mjs");
  for (const limits of [STARTUP_BUDGETS, SHARED_STARTUP_BUDGETS]) {
    assert.equal(
      evaluateBudgets(
        {
          startupP95Ms: 175,
          inputP95Ms: 1,
          rssP95MiB: 300,
          combinedRssP95MiB: 600,
        },
        limits,
        { advisory: STARTUP_ADVISORY },
      ).passed,
      true,
    );
    const slow = evaluateBudgets({ startupP95Ms: 201, inputP95Ms: 1 }, limits, {
      advisory: STARTUP_ADVISORY,
    });
    assert.equal(slow.passed, true);
    assert.deepEqual(slow.warnings, ["startupP95Ms"]);
    assert.equal(slow.checks.startupP95Ms.advisory, true);
    assert.equal(
      evaluateBudgets({ startupP95Ms: 175, inputP95Ms: 17 }, limits, {
        advisory: STARTUP_ADVISORY,
      }).passed,
      false,
    );
    assert.equal(
      evaluateBudgets({ startupP95Ms: 201, inputP95Ms: 1 }, limits).passed,
      false,
    );
  }
});
