import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { spawn } from "node-pty";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  environment,
  integerSetting,
  saveReport,
  benchmarkFingerprint,
} from "./bench-support.mjs";

import {
  createMemorySampler,
  assertSampleContinuity,
} from "./memory-sampling.mjs";

const minutes = integerSetting("HIKARO_SOAK_MINUTES", 30, process.env, 120);
const warmupMinutes = integerSetting(
  "HIKARO_SOAK_WARMUP_MINUTES",
  1,
  process.env,
  10,
);
const check = process.argv.includes("--check");
if (check && minutes < 30)
  throw Error("--check requires at least 30 measured minutes");
const fingerprint = await benchmarkFingerprint();
const home = await mkdtemp(join(tmpdir(), "hikaro-soak-"));
const entry = resolve("dist/hikaro.mjs");
const reportPath =
  process.env.HIKARO_SOAK_OUTPUT ?? "artifacts/benchmark-soak.json";
const report = {
  ...fingerprint,
  schemaVersion: 2,
  assessmentScope: "functional-soak",
  memoryAssessment: "pending-platform-baseline",
  memoryPassed: null,
  environment: environment(),
  minutes,
  warmupMinutes,
  status: "running",
  samples: [],
  turns: 0,
  limits: { measuredMinutes: minutes },
  diagnosticReferences: { legacyRssGrowthPercent: 10 },
  workload:
    "Persistent local SSE fixture host and attached TUI; one streamed prompt every 20s; durable run completion and rendered response checked; no forced GC or process restart",
};
let memorySampler;
let previousSample;
let host,
  terminal,
  db,
  hostExited = false,
  terminalExited = false,
  hostCode,
  terminalCode;
let hostOutput = "",
  output = "";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate, label, timeout = 10000, allowExit = false) => {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (!allowExit && (hostExited || terminalExited))
      throw Error(`Process exited while waiting for ${label}`);
    if (performance.now() >= end)
      throw Error(
        `Timeout: ${label}\n${stripVTControlCharacters(output).slice(-1500)}\n${hostOutput.slice(-1000)}`,
      );
    await pause(25);
  }
};
const rss = (pid) =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim(),
  ) / 1024;
const sample = () => {
  const hostRssMiB = rss(host.pid),
    tuiRssMiB = rss(terminal.pid);
  if (![hostRssMiB, tuiRssMiB].every((v) => Number.isFinite(v) && v > 0))
    throw Error("Invalid RSS sample");
  const hostMemory = memorySampler.sample(host.pid);
  const tuiMemory = memorySampler.sample(terminal.pid);
  return {
    hostRssMiB,
    tuiRssMiB,
    combinedRssMiB: hostRssMiB + tuiRssMiB,
    hostMemory,
    tuiMemory,
    attributedMemoryMiB: hostMemory.memoryMiB + tuiMemory.memoryMiB,
  };
};
const fixture = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (raw.length > 2 * 1024 * 1024)
        throw Error("Fixture request too large");
    }
    const body = JSON.parse(raw);
    const last = body.messages.filter((m) => m.role === "user").at(-1)?.content;
    const text = typeof last === "string" ? last : JSON.stringify(last);
    const marker = [...(text ?? "").matchAll(/soak-\d{5}/g)].at(-1)?.[0];
    if (!marker) throw Error("Fixture request has no workload marker");
    // A bounded deterministic response also makes compaction requests finite.
    // This measures transport/lifecycle stability, not real summary quality.
    const response = `You wrote: ${marker}`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "soak-fixture", object: "chat.completion.chunk", created: 1, model: "soak-fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    chunk({ role: "assistant" });
    for (const part of response.match(/.{1,8}/g)) {
      if (res.destroyed) return;
      chunk({ content: part });
      await pause(12);
    }
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  } catch (error) {
    report.fixtureError = String(error);
    res.destroy();
  }
});
try {
  memorySampler = createMemorySampler();
  report.memoryMetric = memorySampler.metric;
  report.memoryScope =
    "host + one TUI; SQLite worker included in host; fixture excluded";
  await new Promise((done, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", done);
  });
  const port = fixture.address().port;
  host = spawnProcess(
    process.execPath,
    [
      entry,
      "--host",
      "--provider",
      "local",
      "--model",
      "soak-fixture",
      "--base-url",
      `http://127.0.0.1:${port}/v1`,
      "--home",
      home,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  host.once("exit", (code) => {
    hostExited = true;
    hostCode = code;
  });
  host.on("error", (error) => {
    hostOutput += String(error);
    hostExited = true;
  });
  host.stderr.on("data", (d) => {
    hostOutput = (hostOutput + d).slice(-8000);
  });
  await until(
    () => hostOutput.includes("shared host ready:"),
    "host readiness",
  );
  terminal = spawn(
    process.execPath,
    [entry, "--attach", "--home", home, "--client-id", "soak"],
    { cols: 100, rows: 30, env: { ...process.env, TERM: "xterm-256color" } },
  );
  terminal.onExit(({ exitCode }) => {
    terminalExited = true;
    terminalCode = exitCode;
  });
  terminal.onData((d) => {
    output = (output + d).slice(-128000);
  });
  await until(
    () => output.includes("Attached to shared host."),
    "TUI readiness",
  );
  db = new DatabaseSync(join(home, "sessions.sqlite"), { readOnly: true });
  const lastEnd = db.prepare(
    "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE type='run.end'",
  );
  const start = performance.now();
  const warmupEnd = start + warmupMinutes * 60000;
  let measuredStart;
  while (true) {
    const cycleStart = performance.now();
    const marker = `soak-${String(report.turns).padStart(5, "0")}`;
    const previous = lastEnd.get().seq;
    output = "";
    terminal.write(marker + "\r");
    await until(
      () => lastEnd.get().seq > previous,
      `durable completion ${marker}`,
    );
    await until(
      () => stripVTControlCharacters(output).includes(`You wrote: ${marker}`),
      `rendered response ${marker}`,
    );
    const end = db
      .prepare(
        "SELECT data FROM events WHERE type='run.end' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    if (JSON.parse(end.data).status !== "completed")
      throw Error(`Run did not complete: ${end.data}`);
    report.turns++;
    const measurement = sample();
    const now = performance.now();
    const point = { elapsedMs: now - start, wallTimeMs: Date.now() };
    assertSampleContinuity(previousSample, point);
    previousSample = point;
    if (now >= warmupEnd && measuredStart === undefined) {
      measuredStart = now;
      report.baseline = measurement;
      report.measuredStartedAt = new Date().toISOString();
    }
    if (measuredStart !== undefined) {
      report.samples.push({
        elapsedMs: now - measuredStart,
        wallTimeMs: point.wallTimeMs,
        ...measurement,
      });
      report.elapsedMs = now - measuredStart;
      report.final = measurement;
      report.growthPercent =
        (measurement.combinedRssMiB / report.baseline.combinedRssMiB - 1) * 100;
      report.peakCombinedRssMiB = Math.max(
        ...report.samples.map((s) => s.combinedRssMiB),
      );
      report.peakGrowthPercent =
        (report.peakCombinedRssMiB / report.baseline.combinedRssMiB - 1) * 100;
    }
    await saveReport(reportPath, report);
    console.log(
      JSON.stringify({
        turns: report.turns,
        elapsedSeconds: Math.round((now - start) / 1000),
        ...measurement,
        growthPercent: report.growthPercent,
      }),
    );
    if (measuredStart !== undefined && now - measuredStart >= minutes * 60000)
      break;
    await pause(Math.max(0, 20000 - (performance.now() - cycleStart)));
  }
  report.peakCombinedRssMiB = Math.max(
    ...report.samples.map((s) => s.combinedRssMiB),
  );
  report.peakGrowthPercent =
    (report.peakCombinedRssMiB / report.baseline.combinedRssMiB - 1) * 100;
  if (report.fixtureError) throw Error(report.fixtureError);
  report.stabilityPassed = report.elapsedMs >= Math.max(30, minutes) * 60000;
  terminal.write("\x04");
  await until(() => terminalExited, "clean TUI exit", 10000, true);
  host.kill("SIGTERM");
  await until(() => hostExited, "host exit", 10000, true);
  if (hostCode !== 0 || terminalCode !== 0)
    throw Error(`Unclean exit: host=${hostCode}, TUI=${terminalCode}`);
  report.status = report.stabilityPassed ? "passed" : "incomplete";
  if (check && report.status !== "passed") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  memorySampler?.close();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  db?.close();
  if (terminal && !terminalExited) terminal.kill("SIGKILL");
  if (host && !hostExited) host.kill("SIGKILL");
  await Promise.all([
    ...(terminal
      ? [until(() => terminalExited, "TUI cleanup", 10000, true)]
      : []),
    ...(host ? [until(() => hostExited, "host cleanup", 10000, true)] : []),
  ]);
  report.exits = { host: hostCode, tui: terminalCode };
  report.finishedAt = new Date().toISOString();
  await saveReport(reportPath, report);
  await rm(home, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    status: report.status,
    stabilityPassed: report.stabilityPassed,
    memoryPassed: report.memoryPassed,
    error: report.error,
  }),
);
