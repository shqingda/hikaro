import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  tmpdir,
} from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function integerSetting(
  name,
  fallback,
  env = process.env,
  max = 100000,
  min = 1,
) {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (raw === "" || !Number.isSafeInteger(value) || value < min || value > max)
    throw Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function percentile(samples, fraction) {
  if (
    !samples.length ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw Error("Measurements require nonempty, finite, nonnegative samples");
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw Error("Percentile must be greater than 0 and at most 1");
  return [...samples].sort((a, b) => a - b)[
    Math.ceil(samples.length * fraction) - 1
  ];
}

// Advisory limits are reported and listed in `warnings` but never fail the run.
export function evaluateBudgets(metrics, limits, { advisory = [] } = {}) {
  const checks = Object.fromEntries(
    Object.entries(limits).map(([name, max]) => {
      const value = Number.isFinite(metrics[name]) ? metrics[name] : null;
      const check = { value, max, passed: value !== null && value <= max };
      if (advisory.includes(name)) check.advisory = true;
      return [name, check];
    }),
  );
  const entries = Object.entries(checks);
  return {
    passed: entries.every(([, check]) => check.advisory || check.passed),
    warnings: entries
      .filter(([, check]) => check.advisory && !check.passed)
      .map(([name]) => name),
    checks,
  };
}

export function warnBudget(budget) {
  for (const name of budget.warnings ?? []) {
    const { value, max } = budget.checks[name];
    console.warn(
      `warning: ${name} ${value?.toFixed(2)} exceeds advisory ${max}`,
    );
  }
}

export async function withBenchmarkHome(work, root = tmpdir()) {
  const home = await mkdtemp(join(root, "hikaro-bench-"));
  try {
    return await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function environment() {
  let revision = null;
  let dirty = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    dirty = Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    // Source archives need not contain Git metadata.
  }
  return {
    runtime: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    loadAverage: loadavg(),
    freeMemoryMiB: freemem() / 1024 / 1024,
    revision,
    dirty,
  };
}

export async function saveReport(path, report) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}

export async function benchmarkFingerprint(directory = "dist") {
  const bundleFiles = {};
  // Native helpers affect execution too. Read them explicitly so a missing
  // helper fails provenance collection instead of silently shrinking its scope.
  const files = [
    ...(await readdir(directory)).filter((file) => file.endsWith(".mjs")),
    "secure-file-helper",
    "process-snapshot-helper",
  ];
  for (const file of files.sort()) {
    bundleFiles[file] = createHash("sha256")
      .update(await readFile(join(directory, file)))
      .digest("hex");
  }
  return {
    bundleFiles,
    bundleSha256: createHash("sha256")
      .update(JSON.stringify(bundleFiles))
      .digest("hex"),
  };
}

export function isMain(url) {
  return (
    !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url
  );
}
