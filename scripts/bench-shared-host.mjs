import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { startupSample, STARTUP_ADVISORY, STARTUP_BUDGETS } from "./bench.mjs";
import {
  environment,
  benchmarkFingerprint,
  evaluateBudgets,
  warnBudget,
  integerSetting,
  percentile,
  saveReport,
  withBenchmarkHome,
  isMain,
} from "./bench-support.mjs";

// RSS sums double-count shared mappings; retain them as diagnostics only.
// See docs/specs/shared-memory-soak.md for the revised acceptance policy.
export const SHARED_STARTUP_BUDGETS = {
  startupP95Ms: STARTUP_BUDGETS.startupP95Ms,
  inputP95Ms: STARTUP_BUDGETS.inputP95Ms,
};

export async function attachedSample() {
  return withBenchmarkHome(async (home) => {
    const entryPath = resolve("dist/hikaro.mjs");
    const host = spawn(
      process.execPath,
      [entryPath, "--host", "--demo", "--home", home],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      await new Promise((done, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(Error("Shared benchmark host timeout: " + output)),
          10000,
        );
        host.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-8192);
          if (output.includes("shared host ready:")) {
            clearTimeout(timer);
            done();
          }
        });
        host.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        host.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error("Shared benchmark host exited: " + code + " " + output));
        });
      });
      const hostReadyRssMiB =
        Number(
          execFileSync("ps", ["-o", "rss=", "-p", String(host.pid)], {
            encoding: "utf8",
          }).trim(),
        ) / 1024;
      return await withBenchmarkHome(async (cache) => {
        let hostRssMiB;
        const env = { ...process.env, NODE_COMPILE_CACHE: cache };
        delete env.NODE_DISABLE_COMPILE_CACHE;
        const sample = await startupSample({
          live: true,
          entryPath,
          homePath: home,
          extraArgs: ["--attach", "--client-id", "bench"],
          readyText: "Attached to shared host.",
          env,
          onReady: () => {
            hostRssMiB =
              Number(
                execFileSync("ps", ["-o", "rss=", "-p", String(host.pid)], {
                  encoding: "utf8",
                }).trim(),
              ) / 1024;
          },
        });
        return {
          ...sample,
          hostReadyRssMiB,
          hostRssMiB,
          combinedRssMiB: hostRssMiB + sample.rssMiB,
        };
      });
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        const exited = once(host, "exit");
        host.kill("SIGTERM");
        const deadline = setTimeout(() => host.kill("SIGKILL"), 6000);
        try {
          await exited;
        } finally {
          clearTimeout(deadline);
        }
      }
    }
  });
}
export async function main() {
  const runs = integerSetting("HIKARO_BENCH_RUNS", 30, process.env, 1000),
    warmups = integerSetting("HIKARO_BENCH_WARMUPS", 3, process.env, 10, 0);
  const check = process.argv.includes("--check");
  if (check && (runs < 30 || warmups < 3))
    throw Error("--check requires 30 runs and 3 warmups");
  const before = environment();
  const { bundleFiles, bundleSha256 } = await benchmarkFingerprint();
  const firstLaunch = await attachedSample();
  for (let n = 0; n < warmups; n++) await attachedSample();
  const samples = [];
  for (let n = 0; n < runs; n++) samples.push(await attachedSample());
  const metrics = {
    startupP95Ms: percentile(
      samples.map((s) => s.startupMs),
      0.95,
    ),
    inputP95Ms: percentile(
      samples.flatMap((s) => s.inputMs),
      0.95,
    ),
    rssP95MiB: percentile(
      samples.map((s) => s.rssMiB),
      0.95,
    ),
    hostRssP95MiB: percentile(
      samples.map((s) => s.hostRssMiB),
      0.95,
    ),
    combinedRssP95MiB: percentile(
      samples.map((s) => s.combinedRssMiB),
      0.95,
    ),
  };
  const report = {
    schemaVersion: 2,
    assessmentScope: "startup-timing",
    memoryAssessment: "pending-platform-baseline",
    measuredAt: new Date().toISOString(),
    mode: "warm independent host; fresh data home and empty client V8 cache per launch",
    environment: before,
    endingEnvironment: environment(),
    bundleSha256,
    bundleFiles,
    runs,
    warmups,
    inputSamplesPerRun: 20,
    firstLaunch,
    ...metrics,
    budget: evaluateBudgets(metrics, SHARED_STARTUP_BUDGETS, {
      advisory: STARTUP_ADVISORY,
    }),
    samples,
    limitations: [
      "Host reaches Runtime/SQLite readiness before the TUI timer starts. This measures attachment, not cold host startup.",
      "Ready marker is emitted only after hello, snapshot, initial session, history and local draft recovery. Input uses PTY echo, not physical pixels.",
      "RSS values are diagnostics, not release gates. Their sum can double-count shared mappings; no physical-memory acceptance is implied by budget.passed.",
      "Warm OS caches. Current workspace and user skills remain enabled at host. No network/provider or mobile device. No 30-minute soak.",
    ],
  };
  await saveReport(
    process.env.HIKARO_BENCH_OUTPUT ?? "artifacts/benchmark-shared-host.json",
    report,
  );
  console.log(JSON.stringify({ ...metrics, budget: report.budget }));
  warnBudget(report.budget);
  if (check && !report.budget.passed) process.exitCode = 1;
}
if (isMain(import.meta.url)) await main();
