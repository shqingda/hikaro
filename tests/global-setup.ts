import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest mtime under a source tree, skipping generated native helpers. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? newest(path) : statSync(path).mtimeMs,
    );
  }
  return latest;
}

/** Several PTY suites run the built CLI. Rebuild when it is missing or older than the sources. */
export default function setup() {
  if (process.env.HIKARO_TEST_BIN) return;
  let built = 0;
  try {
    built = statSync("dist/hikaro.mjs").mtimeMs;
  } catch {}
  const sources = Math.max(newest("packages"), newest("extensions"));
  if (built >= sources) return;
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
}
