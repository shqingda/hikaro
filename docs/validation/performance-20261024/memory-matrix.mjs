import { spawn as spawnProcess } from "node:child_process";
import { spawn } from "node-pty";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createMemorySampler } from "../../../scripts/memory-sampling.mjs";
import {
  benchmarkFingerprint,
  environment,
  saveReport,
} from "../../../scripts/bench-support.mjs";

const reportPath = "artifacts/memory-matrix-20261024.json";
const entry = resolve("dist/hikaro.mjs");
const sampler = createMemorySampler();
const report = {
  status: "running",
  metric: sampler.metric,
  environment: environment(),
  fingerprint: await benchmarkFingerprint(),
  phases: [],
  scope:
    "Idle local demo processes; 30s warmup then 30 samples 2s apart, two sequential rounds. SQLite workers included in owner. Fixture/driver excluded. Concurrent soak and user applications remain running. No memory pass/fail budget.",
};
const waitFor = async (predicate, label) => {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw Error("Timed out: " + label);
    await pause(25);
  }
};
async function phase(mode, round) {
  const home = await mkdtemp(join(tmpdir(), "hikaro-memory-matrix-"));
  const processes = [];
  const item = {
    mode,
    round,
    startedAt: new Date().toISOString(),
    samples: [],
  };
  report.phases.push(item);
  const tui = async (name, args, readyText) => {
    const process = spawn(
      globalThis.process.execPath,
      [entry, ...args, "--home", home],
      {
        cols: 100,
        rows: 30,
        env: { ...globalThis.process.env, TERM: "xterm-256color" },
      },
    );
    const record = {
      name,
      pid: process.pid,
      process,
      exited: false,
      output: "",
      code: null,
      tui: true,
    };
    processes.push(record);
    process.onData((data) => {
      record.output = (record.output + data).slice(-32000);
    });
    process.onExit(({ exitCode }) => {
      record.exited = true;
      record.code = exitCode;
    });
    await waitFor(
      () => record.exited || record.output.includes(readyText),
      name,
    );
    if (record.exited) throw Error(name + " exited before readiness");
  };
  try {
    if (mode === "standalone") await tui("tui", ["--demo"], "/help");
    else {
      const process = spawnProcess(
        globalThis.process.execPath,
        [entry, "--host", "--demo", "--home", home],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const host = {
        name: "host",
        pid: process.pid,
        process,
        exited: false,
        output: "",
        code: null,
        tui: false,
      };
      processes.push(host);
      process.stderr.on("data", (data) => {
        host.output = (host.output + data).slice(-32000);
      });
      process.on("exit", (code) => {
        host.exited = true;
        host.code = code;
      });
      process.on("error", (error) => {
        host.exited = true;
        host.output += String(error);
      });
      await waitFor(
        () => host.exited || host.output.includes("shared host ready:"),
        "host",
      );
      if (host.exited) throw Error("Host exited before readiness");
      for (
        let i = 0;
        i < (mode === "host+2" ? 2 : mode === "host+1" ? 1 : 0);
        i++
      )
        await tui(
          "tui" + (i + 1),
          ["--attach", "--client-id", "matrix-" + i],
          "Attached to shared host.",
        );
    }
    item.processes = processes.map(({ name, pid }) => ({ name, pid }));
    await pause(30000);
    for (let i = 0; i < 30; i++) {
      if (processes.some((p) => p.exited))
        throw Error("Process exited during memory sampling");
      const values = Object.fromEntries(
        processes.map((p) => [p.name, sampler.sample(p.pid)]),
      );
      item.samples.push({
        wallTimeMs: Date.now(),
        processes: values,
        attributedMiB: Object.values(values).reduce(
          (sum, p) => sum + p.memoryMiB,
          0,
        ),
      });
      await saveReport(reportPath, report);
      if (i < 29) await pause(2000);
    }
    for (const p of [...processes].reverse()) {
      if (p.tui) p.process.write("\x04");
      else p.process.kill("SIGTERM");
      await waitFor(() => p.exited, p.name + " exit");
      if (p.code !== 0) throw Error(p.name + " unclean exit " + p.code);
    }
    item.exits = processes.map(({ name, code }) => ({ name, code }));
    item.finishedAt = new Date().toISOString();
    await saveReport(reportPath, report);
    console.log(
      JSON.stringify({
        mode,
        round,
        samples: item.samples.length,
        status: "completed",
      }),
    );
  } finally {
    for (const p of processes) if (!p.exited) p.process.kill("SIGKILL");
    await waitFor(() => processes.every((p) => p.exited), "cleanup");
    await rm(home, { recursive: true, force: true });
  }
}
try {
  for (let round = 1; round <= 2; round++)
    for (const mode of ["standalone", "host", "host+1", "host+2"])
      await phase(mode, round);
  report.finalFingerprint = await benchmarkFingerprint();
  if (report.finalFingerprint.bundleSha256 !== report.fingerprint.bundleSha256)
    throw Error("Build changed during measurement");
  report.status = "completed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  sampler.close();
  report.finishedAt = new Date().toISOString();
  await saveReport(reportPath, report);
}
