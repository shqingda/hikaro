import { spawn } from "node-pty";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const times = [],
  rss = [];
const count = Number(process.env.HIKARO_BENCH_RUNS ?? 30);
for (let i = 0; i < count; i++) {
  const home = await mkdtemp(join(tmpdir(), "hikaro-bench-"));
  const start = performance.now();
  await new Promise((resolveRun, reject) => {
    const p = spawn(
      process.execPath,
      [
        resolve("dist/hikaro.mjs"),
        ...(process.env.HIKARO_BENCH_LIVE ? [] : ["--demo"]),
        "--home",
        home,
      ],
      { cols: 100, rows: 30, env: { ...process.env, TERM: "xterm-256color" } },
    );
    let ready = false;
    let output = "";
    const timeout = setTimeout(() => {
      p.kill();
      reject(Error("TUI startup timeout"));
    }, 10000);
    p.onData((chunk) => {
      output = (output + chunk).slice(-20000);
      if (!ready && output.includes("/help")) {
        ready = true;
        times.push(performance.now() - start);
        try {
          rss.push(
            Number(
              execFileSync("ps", ["-o", "rss=", "-p", String(p.pid)], {
                encoding: "utf8",
              }).trim(),
            ) / 1024,
          );
        } catch {}
        p.write("\x04");
      }
    });
    p.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (!ready || exitCode !== 0) reject(Error(`TUI exit ${exitCode}`));
      else resolveRun();
    });
  });
  await rm(home, { recursive: true, force: true });
}
times.sort((a, b) => a - b);
rss.sort((a, b) => a - b);
const result = {
  mode: process.env.HIKARO_BENCH_LIVE
    ? "default Anthropic catalog loaded, no request sent"
    : "offline demo (no provider SDK loaded)",
  runtime: process.version,
  runs: count,
  startupP50Ms: times[Math.floor(count * 0.5)],
  startupP95Ms: times[Math.min(count - 1, Math.ceil(count * 0.95) - 1)],
  rssP95MiB: rss[Math.min(rss.length - 1, Math.ceil(rss.length * 0.95) - 1)],
  limitations:
    "Warm OS caches; process RSS includes SQLite worker, excludes external tools. Live provider, input latency, 10k events, and 30-minute stability require separate measurements.",
};
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/benchmark.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
