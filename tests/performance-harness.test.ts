import { describe, expect, it } from "vitest";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const supportPath = new URL("../scripts/bench-support.mjs", import.meta.url)
  .href;
const harnessPath = new URL("../scripts/bench-harness.mjs", import.meta.url)
  .href;

describe("performance measurement guardrails", () => {
  it("rejects invalid sample counts instead of reporting empty or unbounded results", async () => {
    const { integerSetting } = await import(supportPath);
    expect(integerSetting("RUNS", 3, { RUNS: undefined }, 100)).toBe(3);
    expect(integerSetting("RUNS", 3, { RUNS: "7" }, 100)).toBe(7);
    for (const value of ["", "0", "-1", "1.2", "NaN", "Infinity", "101"])
      expect(() => integerSetting("RUNS", 3, { RUNS: value }, 100)).toThrow(
        /RUNS/,
      );
  });

  it("uses nearest-rank percentiles and refuses missing samples", async () => {
    const { percentile } = await import(supportPath);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(
      percentile(
        Array.from({ length: 30 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(29);
    expect(() => percentile([], 0.95)).toThrow(/sample/i);
    expect(() => percentile([1, NaN], 0.95)).toThrow(/sample/i);
  });

  it("fails a budget when a measurement is missing or over its limit", async () => {
    const { evaluateBudgets } = await import(supportPath);
    const result = evaluateBudgets(
      { latencyMs: 101, memoryMiB: 64 },
      { latencyMs: 100, memoryMiB: 64, inputMs: 50 },
    );
    expect(result.passed).toBe(false);
    expect(result.checks.latencyMs.passed).toBe(false);
    expect(result.checks.memoryMiB.passed).toBe(true);
    expect(result.checks.inputMs.passed).toBe(false);
    expect(result.checks.inputMs.value).toBeNull();
  });

  it("cleans its isolated home even when a measured workload fails", async () => {
    const { withBenchmarkHome } = await import(supportPath);
    const root = await mkdtemp(join(tmpdir(), "hikaro-bench-test-"));
    let observedHome = "";
    try {
      await expect(
        withBenchmarkHome(async (home: string) => {
          observedHome = home;
          await access(home);
          throw Error("fixture failure");
        }, root),
      ).rejects.toThrow("fixture failure");
      expect(observedHome.startsWith(join(root, "hikaro-bench-"))).toBe(true);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("deterministic performance workloads", () => {
  it("verifies persisted event pagination and lossless streaming before reporting timings", async () => {
    const { runHarnessSample } = await import(harnessPath);
    const result = await runHarnessSample({
      events: 120,
      chunks: 128,
      burstSize: 16,
      querySamples: 5,
    });
    expect(result.correctness).toMatchObject({
      persistedEvents: 120,
      replayedEvents: 120,
      historyMessages: 12,
      streamChunks: 128,
      streamTextMatches: true,
      streamCompleted: true,
    });
    expect(result.correctness.persistedStreamDeltas).toBeGreaterThan(0);
    expect(result.correctness.persistedStreamDeltas).toBeLessThan(128);
    for (const key of ["appendMs", "replayMs", "messagePageP95Ms", "streamMs"])
      expect(result.metrics[key]).toBeGreaterThan(0);
    expect(result.querySamplesMs).toHaveLength(5);
  });
});
