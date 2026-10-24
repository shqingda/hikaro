import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function parsePss(text) {
  const value = (key) => {
    const matches = [
      ...text.matchAll(new RegExp(`^${key}:\\s+(\\d+) kB$`, "gm")),
    ];
    if (matches.length !== 1) throw Error(`Missing or duplicate ${key}`);
    return Number(matches[0][1]) / 1024;
  };
  return { memoryMiB: value("Pss"), swapPssMiB: value("SwapPss") };
}

export function createMemorySampler() {
  let directory;
  let helper;
  if (process.platform === "darwin") {
    directory = mkdtempSync(join(tmpdir(), "hikaro-memory-helper-"));
    helper = join(directory, "footprint");
    try {
      execFileSync(
        "cc",
        [
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          fileURLToPath(
            new URL("./native/memory-footprint.c", import.meta.url),
          ),
          "-o",
          helper,
        ],
        { timeout: 30000 },
      );
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  } else if (process.platform !== "linux")
    throw Error("Unsupported memory sampling platform");
  return {
    metric:
      process.platform === "darwin" ? "macos-physical-footprint" : "linux-pss",
    sample(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid PID");
      if (process.platform === "linux")
        return parsePss(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      const bytes = Number(
        execFileSync(helper, [String(pid)], {
          encoding: "utf8",
          timeout: 2000,
        }).trim(),
      );
      if (!Number.isFinite(bytes) || bytes <= 0)
        throw Error("Invalid footprint sample");
      return { memoryMiB: bytes / 1048576 };
    },
    close() {
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Check wall time as well as monotonic time: sleep behavior differs by OS.
export function assertSampleContinuity(previous, current, maxGapMs = 40000) {
  if (!previous) return;
  for (const clock of ["elapsedMs", "wallTimeMs"]) {
    const gap = current[clock] - previous[clock];
    if (!Number.isFinite(gap) || gap < 0 || gap > maxGapMs)
      throw Error(`Discontinuous soak sample (${clock} gap ${gap} ms)`);
  }
}
