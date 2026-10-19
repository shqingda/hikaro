import { spawn } from "node-pty";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  environment,
  evaluateBudgets,
  integerSetting,
  isMain,
  percentile,
  saveReport,
  withBenchmarkHome,
} from "./bench-support.mjs";

// Existing product targets from docs/validation.md; do not widen these just
// because a new machine/runtime or a concurrent build produces a slower run.
export const STARTUP_BUDGETS = {
  startupP95Ms: 200,
  inputP95Ms: 16,
  rssP95MiB: 100,
};

export async function startupSample({
  live = false,
  inputSamples = 20,
  entryPath = resolve("dist/hikaro.mjs"),
  env = process.env,
  homePath,
  extraArgs = [],
  readyText = "/help",
  onReady,
} = {}) {
  integerSetting("inputSamples", inputSamples, {}, 1000);
  const run = async (home) => {
    const start = performance.now();
    return new Promise((resolveRun, reject) => {
      const terminal = spawn(
        process.execPath,
        [entryPath, ...(live ? [] : ["--demo"]), "--home", home, ...extraArgs],
        {
          cols: 100,
          rows: 30,
          env: { ...env, TERM: "xterm-256color" },
        },
      );
      let startupMs;
      let rssMiB;
      let output = "";
      let failure;
      let marker;
      let inputStart;
      const inputMs = [];
      const timeout = setTimeout(() => {
        failure = Error(
          "TUI benchmark timed out waiting for readiness, input, or exit",
        );
        terminal.kill("SIGKILL");
      }, 10000);
      const nextInput = () => {
        output = "";
        marker = `bench-input-${String(inputMs.length).padStart(4, "0")}`;
        inputStart = performance.now();
        terminal.write(`\x15${marker}`);
      };
      terminal.onData((chunk) => {
        output = (output + chunk).slice(-20000);
        if (failure) return;
        try {
          if (startupMs === undefined && output.includes(readyText)) {
            startupMs = performance.now() - start;
            rssMiB =
              Number(
                execFileSync("ps", ["-o", "rss=", "-p", String(terminal.pid)], {
                  encoding: "utf8",
                  timeout: 2000,
                }).trim(),
              ) / 1024;
            if (!Number.isFinite(rssMiB) || rssMiB <= 0)
              throw Error("Could not measure TUI RSS");
            onReady?.();
            nextInput();
          } else if (
            marker &&
            stripVTControlCharacters(output).includes(marker)
          ) {
            inputMs.push(performance.now() - inputStart);
            marker = undefined;
            if (inputMs.length < inputSamples) nextInput();
            else terminal.write("\x15\x04");
          }
        } catch (error) {
          failure = error;
          terminal.kill("SIGKILL");
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (
          startupMs === undefined ||
          inputMs.length !== inputSamples ||
          exitCode !== 0
        )
          reject(
            Error(
              `TUI benchmark exited before completion (${exitCode}):\n${stripVTControlCharacters(output).slice(-2000)}`,
            ),
          );
        else resolveRun({ startupMs, rssMiB, inputMs });
      });
    });
  };
  return homePath ? run(homePath) : withBenchmarkHome(run);
}

export async function main() {
  const count = integerSetting("HIKARO_BENCH_RUNS", 30, process.env, 1000);
  const warmups = integerSetting("HIKARO_BENCH_WARMUPS", 3, process.env, 10, 0);
  const live = process.env.HIKARO_BENCH_LIVE === "1";
  if (
    process.env.HIKARO_BENCH_LIVE !== undefined &&
    !["0", "1"].includes(process.env.HIKARO_BENCH_LIVE)
  )
    throw Error("HIKARO_BENCH_LIVE must be 0 or 1");
  const check = process.argv.includes("--check");
  if (check && (count < 30 || warmups < 3))
    throw Error("--check requires at least 30 measured launches and 3 warmups");
  const cacheMode = process.env.HIKARO_BENCH_CACHE ?? "cold";
  if (!["cold", "warm", "disabled"].includes(cacheMode))
    throw Error("HIKARO_BENCH_CACHE must be cold, warm, or disabled");
  const initialEnvironment = environment();
  const bundleFiles = {};
  for (const file of (await readdir("dist")).sort()) {
    if (!file.endsWith(".mjs") && file !== "secure-file-helper") continue;
    bundleFiles[file] = createHash("sha256")
      .update(await readFile(join("dist", file)))
      .digest("hex");
  }
  const bundleSha256 = createHash("sha256")
    .update(JSON.stringify(bundleFiles))
    .digest("hex");
  const { samples, firstLaunch } = await withBenchmarkHome(
    async (cacheRoot) => {
      const sample = async () => {
        const run = (cache) => {
          const env = { ...process.env, NODE_COMPILE_CACHE: cache };
          if (cacheMode === "disabled") env.NODE_DISABLE_COMPILE_CACHE = "1";
          else delete env.NODE_DISABLE_COMPILE_CACHE;
          return startupSample({ live, env });
        };
        // OS caches are warmed in every mode; cold means V8's cache starts empty
        // for every child, including measured runs. Never remove a user's cache.
        return cacheMode === "cold"
          ? withBenchmarkHome((cache) => run(cache), cacheRoot)
          : run(cacheRoot);
      };
      const firstLaunch = await sample();
      for (let i = 0; i < warmups; i++) await sample();
      const samples = [];
      for (let i = 0; i < count; i++) samples.push(await sample());
      return { samples, firstLaunch };
    },
  );
  const metrics = {
    startupP50Ms: percentile(
      samples.map((s) => s.startupMs),
      0.5,
    ),
    startupP95Ms: percentile(
      samples.map((s) => s.startupMs),
      0.95,
    ),
    inputP50Ms: percentile(
      samples.flatMap((s) => s.inputMs),
      0.5,
    ),
    inputP95Ms: percentile(
      samples.flatMap((s) => s.inputMs),
      0.95,
    ),
    rssP95MiB: percentile(
      samples.map((s) => s.rssMiB),
      0.95,
    ),
  };
  const budget = evaluateBudgets(metrics, STARTUP_BUDGETS);
  const result = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    mode: live
      ? "default Anthropic catalog loaded, no request sent"
      : "offline demo, no provider request",
    environment: initialEnvironment,
    endingEnvironment: environment(),
    bundleSha256,
    bundleFiles,
    cacheMode,
    firstLaunch,
    runs: count,
    warmups,
    inputSamplesPerRun: 20,
    ...metrics,
    budget,
    samples,
    limitations: [
      "Warm OS caches; fresh Hikaro data home per launch. Current workspace and user skill discovery remain enabled.",
      "Compile cache state is explicit: cold uses an empty temporary cache per launch; warm shares one isolated cache; disabled turns V8 caching off. firstLaunch precedes warmups and is not a percentile or a cold-disk measurement.",
      "Startup measures PTY spawn to the first ready /help frame. Input measures PTY write to echoed editor content, not physical display pixels.",
      "RSS is sampled at readiness, includes the SQLite worker and excludes external tools. The benchmark driver is a separate process.",
      "No live request, streaming-to-terminal latency, 10k history rendering, or 30-minute stability measurement. Run bench:harness separately for storage/core bursts.",
      "Nearest-rank percentiles. Concurrent build/test work and OS load affect results; compare raw samples on the same host/runtime.",
    ],
  };
  await saveReport(
    process.env.HIKARO_BENCH_OUTPUT ?? "artifacts/benchmark.json",
    result,
  );
  console.log(JSON.stringify(result, null, 2));
  if (check && !budget.passed) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
