import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startupSample, STARTUP_BUDGETS } from "../../../scripts/bench.mjs";
import {
  benchmarkFingerprint,
  environment,
  evaluateBudgets,
  percentile,
  saveReport,
  withBenchmarkHome,
} from "../../../scripts/bench-support.mjs";

// Diagnostic only. Reuse the unchanged readiness/input/cleanup implementations.
const output =
  process.env.HIKARO_PAIRED_OUTPUT ?? "artifacts/startup-opt-paired.json";
const directories = {
  baseline: resolve(
    process.env.HIKARO_PAIRED_BASELINE ?? "artifacts/startup-opt-baseline-dist",
  ),
  candidate: resolve(process.env.HIKARO_PAIRED_CANDIDATE ?? "dist"),
};
const fingerprints = {};
const attached = {};
for (const [variant, directory] of Object.entries(directories)) {
  fingerprints[variant] = await benchmarkFingerprint(directory);
  const source = (await readFile("scripts/bench-shared-host.mjs", "utf8"))
    .replaceAll('from "./', 'from "../scripts/')
    .replace(
      'resolve("dist/hikaro.mjs")',
      JSON.stringify(resolve(directory, "hikaro.mjs")),
    )
    .replace(
      "await benchmarkFingerprint()",
      `await benchmarkFingerprint(${JSON.stringify(directory)})`,
    );
  const path = resolve(`artifacts/startup-opt-attached-${variant}-driver.mjs`);
  await writeFile(path, source);
  attached[variant] = (await import(pathToFileURL(path).href)).attachedSample;
}

const results = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: environment(),
  runs: 30,
  warmups: 3,
  inputSamplesPerRun: 20,
  fingerprints,
  limitations: [
    "Alternating baseline/candidate order per pair, original benchmark readiness and input methods, no concurrent test/build.",
    "Fresh data home and empty client V8 cache per sample; warm OS cache on a shared development machine.",
    "Attachment excludes host startup. No provider request, long history or soak measurement.",
  ],
  modes: {},
};

for (const mode of ["standalone", "attached"]) {
  const sample = async (variant) =>
    mode === "attached"
      ? attached[variant]()
      : withBenchmarkHome((cache) => {
          const env = { ...process.env, NODE_COMPILE_CACHE: cache };
          delete env.NODE_DISABLE_COMPILE_CACHE;
          return startupSample({
            entryPath: resolve(directories[variant], "hikaro.mjs"),
            env,
          });
        });
  const result = {
    environment: environment(),
    firstLaunch: {},
    samples: { baseline: [], candidate: [] },
    order: [],
  };
  for (const variant of Object.keys(directories))
    result.firstLaunch[variant] = await sample(variant);
  for (let i = 0; i < 3; i++)
    for (const variant of i % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"])
      await sample(variant);
  for (let i = 0; i < 30; i++) {
    const order = i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    result.order.push(order);
    for (const variant of order)
      result.samples[variant].push(await sample(variant));
    if ((i + 1) % 10 === 0) console.log(`${mode}: ${i + 1}/30 pairs`);
  }
  result.endingEnvironment = environment();
  result.metrics = {};
  for (const variant of Object.keys(directories)) {
    const samples = result.samples[variant];
    const metrics = {
      startupP50Ms: percentile(
        samples.map((s) => s.startupMs),
        0.5,
      ),
      startupP95Ms: percentile(
        samples.map((s) => s.startupMs),
        0.95,
      ),
      inputP95Ms: percentile(
        samples.flatMap((s) => s.inputMs),
        0.95,
      ),
      over200: samples.filter((s) => s.startupMs > 200).length,
    };
    result.metrics[variant] = {
      ...metrics,
      budget: evaluateBudgets(metrics, STARTUP_BUDGETS),
    };
  }
  results.modes[mode] = result;
  console.log(mode, result.metrics);
  await saveReport(output, results);
}
results.endingEnvironment = environment();
results.endingFingerprints = {};
for (const [variant, directory] of Object.entries(directories)) {
  results.endingFingerprints[variant] = await benchmarkFingerprint(directory);
  if (
    results.endingFingerprints[variant].bundleSha256 !==
    fingerprints[variant].bundleSha256
  )
    throw Error(`${variant} changed during benchmark`);
}
await saveReport(output, results);
