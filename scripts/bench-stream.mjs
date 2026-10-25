import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { Worker } from "node:worker_threads";
import { spawn } from "node-pty";
import {
  benchmarkFingerprint,
  environment,
  evaluateBudgets,
  integerSetting,
  isMain,
  percentile,
  saveReport,
  withBenchmarkHome,
} from "./bench-support.mjs";

const scenarios = [
  "normal",
  "burst100",
  "burst1000",
  "markdown",
  "history10000",
  "interaction",
];
const markerPattern = /HKB(\d+)_(\d+)X/g;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const markdown =
  "SCROLL-TOP\n\n" +
  "## 中文 heading\n\n**Bold** and `code`, emoji 🙂.\n\n- List entry\n- Another entry\n\n".repeat(
    150,
  );

// This trusted plugin exists only inside an isolated benchmark home. Timestamps
// travel in the generated text, avoiding a logging/IPC write before each yield.
function fixturePlugin(prefix, samples) {
  return {
    id: "stream-benchmark",
    apiVersion: 1,
    setup(api) {
      api.registerProvider("stream-benchmark", async () => ({
        id: "stream-benchmark",
        model: "fixture",
        contextWindow: 1_000_000,
        async *stream({ messages, signal }) {
          const scenario = messages
            .filter((message) => message.role === "user")
            .at(-1).text;
          const count = scenario === "interaction" ? 200 : samples;
          const burst =
            scenario === "burst1000" ? 1000 : scenario === "burst100" ? 100 : 1;
          let text = "";
          if (scenario === "markdown" || scenario === "interaction") {
            text += prefix;
            yield { type: "text", text: prefix };
          }
          for (let n = 0; n < count; n++) {
            signal.throwIfAborted();
            const begin = process.hrtime.bigint();
            for (let i = 0; i < burst; i++) {
              text += "x";
              yield { type: "text", text: "x" };
            }
            const marker = `\nHKB${begin}_${process.hrtime.bigint()}X\n`;
            text += marker;
            yield { type: "text", text: marker };
            await new Promise((done) => setTimeout(done, 45));
          }
          yield {
            type: "done",
            message: { role: "assistant", text, timestamp: Date.now() },
            usage: { input: 1, output: text.length, cost: 0 },
          };
        },
      }));
    },
  };
}

export function verifyStreamRecords(records, scenario, samples, visible) {
  const end = records
    .filter((record) => record.type === "run.end")
    .at(-1)?.data;
  const deltas = records
    .filter((record) => record.type === "text.delta")
    .map((record) => record.data.text)
    .join("");
  if (scenario === "interaction") {
    assert.equal(
      end?.status,
      "cancelled",
      "Cancelled run must have a durable cancelled status",
    );
    assert.ok(
      deltas.includes("HKB"),
      "Cancelled run must retain streamed text",
    );
    assert.ok(
      !records.some(
        (record) =>
          record.type === "message" && record.data.message.role === "assistant",
      ),
      "Cancellation must not invent a completed assistant message",
    );
    return { completed: false, cancelled: true, persistedChars: deltas.length };
  }
  assert.equal(end?.status, "completed", "Run status must be completed");
  const final = records
    .filter(
      (record) =>
        record.type === "message" && record.data.message.role === "assistant",
    )
    .at(-1)?.data.message.text;
  assert.equal(deltas, final, "Durable deltas must match the final message");
  const markers = [...deltas.matchAll(markerPattern)].map((match) => match[0]);
  assert.equal(
    markers.length,
    samples,
    "Every provider marker must be persisted",
  );
  assert.deepEqual(
    new Set(visible),
    new Set(markers),
    "Every provider marker must reach visible terminal output",
  );
  const burst =
    scenario === "burst1000" ? 1000 : scenario === "burst100" ? 100 : 1;
  const expected =
    (scenario === "markdown" ? markdown : "") +
    markers.map((marker) => "x".repeat(burst) + "\n" + marker + "\n").join("");
  assert.equal(
    deltas,
    expected,
    "Persisted response must contain every workload chunk in order",
  );
  return {
    completed: true,
    persistedChars: deltas.length,
    markers: markers.length,
    providerChunks: samples * (burst + 1) + Number(scenario === "markdown"),
  };
}

async function seed(entry, home, cwd, history) {
  const worker = new Worker(join(dirname(entry), "worker.mjs"), {
    workerData: { path: join(home, "sessions.sqlite") },
  });
  let id = 0;
  const request = (method, args = {}) =>
    new Promise((done, reject) => {
      const received = (reply) => {
        worker.off("error", failed);
        reply.error ? reject(Error(reply.error)) : done(reply.result);
      };
      const failed = (error) => {
        worker.off("message", received);
        reject(error);
      };
      worker.once("message", received);
      worker.once("error", failed);
      worker.postMessage({ id: ++id, method, args });
    });
  let session;
  try {
    session = await request("createSession", {
      cwd,
      modelSelection: {
        provider: "stream-benchmark",
        model: "fixture",
        settings: {},
      },
    });
    await request("rememberSession", { id: session.id });
    await request("close");
  } finally {
    await worker.terminate();
  }
  if (history) {
    const db = new DatabaseSync(join(home, "sessions.sqlite"));
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,'message',?,?)",
      );
      for (let n = 0; n < history; n++)
        insert.run(
          session.id,
          JSON.stringify({
            message: {
              role: n % 2 ? "assistant" : "user",
              text: `History ${n} 中文 previous conversation.`,
              timestamp: n,
            },
          }),
          n,
        );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  return session.id;
}

export async function runStreamSample({
  entryPath = resolve("dist/hikaro.mjs"),
  mode,
  scenario,
  samples = 20,
}) {
  assert.ok(["standalone", "attached"].includes(mode), "Invalid mode");
  assert.ok(scenarios.includes(scenario), "Invalid scenario");
  assert.ok(
    Number.isSafeInteger(samples) && samples >= 2 && samples <= 100,
    "Invalid sample count",
  );
  return withBenchmarkHome(async (home) => {
    await mkdir(join(home, "workspace"));
    const cwd = await realpath(join(home, "workspace"));
    await writeFile(
      join(home, "fixture.mjs"),
      `export default (${fixturePlugin.toString()})(${JSON.stringify(markdown)}, ${samples});`,
    );
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ plugins: [{ path: "fixture.mjs", trusted: true }] }),
    );
    const session = await seed(
      entryPath,
      home,
      cwd,
      scenario === "history10000" ? 10000 : 0,
    );
    let terminal,
      host,
      db,
      terminalCode,
      hostCode,
      hostOutput = "",
      output = "";
    const latency = new Map(),
      inputMs = [];
    let inputPending,
      measurementError,
      outputBytes = 0;
    const wait = async (predicate, label, timeout = 10000) => {
      const deadline = performance.now() + timeout;
      while (!predicate()) {
        if (measurementError) throw measurementError;
        if (terminalCode !== undefined || (host && hostCode !== undefined))
          throw Error(
            `Process exited while waiting for ${label}: TUI=${terminalCode}, host=${hostCode}\n${stripVTControlCharacters(output).slice(-1500)}\n${hostOutput.slice(-1000)}`,
          );
        if (performance.now() >= deadline)
          throw Error(
            `Timeout: ${label}\n${stripVTControlCharacters(output).slice(-1500)}\n${hostOutput.slice(-1000)}`,
          );
        await pause(5);
      }
    };
    try {
      if (mode === "attached") {
        host = spawnProcess(
          process.execPath,
          [
            entryPath,
            "--host",
            "--home",
            home,
            "--cwd",
            cwd,
            "--provider",
            "stream-benchmark",
            "--model",
            "fixture",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        host.once("exit", (code) => {
          hostCode = code;
        });
        host.once("error", (error) => {
          hostOutput += String(error);
          hostCode = -1;
        });
        host.stderr.on("data", (chunk) => {
          hostOutput = (hostOutput + chunk).slice(-8000);
        });
        await wait(
          () => hostOutput.includes("shared host ready:"),
          "host ready",
        );
      }
      terminal = spawn(
        process.execPath,
        [
          entryPath,
          "--home",
          home,
          "--cwd",
          cwd,
          "--session",
          session,
          ...(mode === "attached"
            ? ["--attach", "--client-id", "stream-benchmark"]
            : []),
        ],
        {
          cols: 100,
          rows: 30,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      terminal.onExit(({ exitCode }) => {
        terminalCode = exitCode;
      });
      terminal.onData((chunk) => {
        const now = process.hrtime.bigint();
        outputBytes += Buffer.byteLength(chunk);
        output = (output + chunk).slice(-256000);
        const plain = stripVTControlCharacters(output);
        for (const match of plain.matchAll(markerPattern)) {
          if (latency.has(match[0])) continue;
          const ms = Number(now - BigInt(match[2])) / 1e6;
          const burstMs = Number(now - BigInt(match[1])) / 1e6;
          if (ms < 0 || burstMs < ms) {
            measurementError = Error(
              "Cross-process monotonic timestamps must be comparable",
            );
            return;
          }
          latency.set(match[0], { marker: match[0], ms, burstMs });
        }
        if (inputPending && plain.includes(inputPending.marker)) {
          inputMs.push(Number(now - inputPending.start) / 1e6);
          inputPending = undefined;
        }
      });
      await wait(
        () =>
          output.includes(
            mode === "attached" ? "Attached to shared host." : "/help",
          ),
        "TUI ready",
      );
      db = new DatabaseSync(join(home, "sessions.sqlite"), { readOnly: true });
      const startSeq = db
        .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events")
        .get().seq;
      const ended = db.prepare(
        "SELECT data FROM events WHERE sessionId=? AND type='run.end' AND seq>? ORDER BY seq DESC LIMIT 1",
      );
      output = "";
      outputBytes = 0;
      terminal.write(scenario + "\r");
      let interaction;
      if (scenario === "interaction") {
        await wait(() => latency.size >= 3, "stream before input");
        for (let n = 0; n < 20; n++) {
          output = "";
          inputPending = {
            marker: `input-${String(n).padStart(3, "0")}`,
            start: process.hrtime.bigint(),
          };
          terminal.write("\x15" + inputPending.marker);
          await wait(() => !inputPending, "input echo");
        }
        output = "";
        const scrollStart = performance.now();
        terminal.write("\x1b[1;5H"); // Ctrl+Home: primary transcript top.
        await wait(
          () => stripVTControlCharacters(output).includes("SCROLL-TOP"),
          "scroll to earlier text",
        );
        const scrollMs = performance.now() - scrollStart;
        await pause(100);
        const seen = latency.size;
        terminal.write("\x1b[1;5F"); // Ctrl+End: resume following the stream.
        await wait(() => latency.size >= seen + 2, "return to latest output");
        terminal.write("\x15");
        const cancelStart = performance.now();
        terminal.write("\x03");
        await wait(() => ended.get(session, startSeq), "durable cancellation");
        interaction = {
          inputMs,
          scrollMs,
          returnedToLatest: true,
          cancelMs: performance.now() - cancelStart,
        };
      } else {
        await wait(() => ended.get(session, startSeq), "durable completion");
        await wait(() => latency.size >= samples, "all terminal markers");
      }
      const records = db
        .prepare(
          "SELECT type,data FROM events WHERE sessionId=? AND seq>? ORDER BY seq",
        )
        .all(session, startSeq)
        .map((row) => ({ type: row.type, data: JSON.parse(row.data) }));
      const correctness = verifyStreamRecords(records, scenario, samples, [
        ...latency.keys(),
      ]);
      terminal.write("\x15\x04");
      // Exit is expected here, so use a separate bounded wait.
      const exitDeadline = performance.now() + 6000;
      while (terminalCode === undefined && performance.now() < exitDeadline)
        await pause(10);
      assert.equal(terminalCode, 0, "TUI must exit cleanly");
      if (host) {
        host.kill("SIGTERM");
        const deadline = performance.now() + 6000;
        while (hostCode === undefined && performance.now() < deadline)
          await pause(10);
        assert.equal(hostCode, 0, "Host must exit cleanly");
      }
      return {
        mode,
        scenario,
        correctness,
        latency: [...latency.values()],
        outputBytes,
        interaction,
        exits: { terminal: terminalCode, host: hostCode },
      };
    } finally {
      db?.close();
      if (terminal && terminalCode === undefined) terminal.kill("SIGKILL");
      if (host && hostCode === undefined) host.kill("SIGKILL");
      const deadline = performance.now() + 6000;
      while (
        ((terminal && terminalCode === undefined) ||
          (host && hostCode === undefined)) &&
        performance.now() < deadline
      )
        await pause(10);
    }
  });
}

export async function main() {
  const entryPath = resolve(
    process.env.HIKARO_STREAM_ENTRY ?? "dist/hikaro.mjs",
  );
  const runs = integerSetting("HIKARO_STREAM_RUNS", 3, process.env, 30);
  const warmups = integerSetting("HIKARO_STREAM_WARMUPS", 1, process.env, 3, 0);
  const check = process.argv.includes("--check");
  if (check && (runs < 3 || warmups < 1))
    throw Error("--check requires 3 measured runs and 1 warmup");
  const report = {
    schemaVersion: 1,
    assessmentScope: "local-provider-to-PTY-output",
    ...(await benchmarkFingerprint(dirname(entryPath))),
    environment: environment(),
    runs,
    warmups,
    samplesPerRun: 20,
    results: [],
    status: "running",
    limitations: [
      "Local trusted fixture yields normalized provider deltas; no external model or network latency. Provider yield is timestamped with the same-host monotonic clock, PTY output reception is the endpoint, not display pixels.",
      "Each burst has 1/100/1000 chunks followed by a timed visible marker. Both marker-yield latency and burst-start-to-marker latency are retained; all durable chunks and final text must match.",
      "Markers are 45ms apart to measure separate visible frames. A 10,000-message SQLite history is restored before the measured response; startup time is covered by the existing startup benchmark.",
      "During deliberate scroll-away, new output is not expected to be visible. Interaction reports input, scroll and cancellation separately; its visible marker timings do not enter the 33ms stream budget.",
    ],
  };
  const output =
    process.env.HIKARO_STREAM_OUTPUT ?? "artifacts/benchmark-stream.json";
  try {
    for (const mode of ["standalone", "attached"])
      for (const scenario of scenarios) {
        for (let n = 0; n < warmups; n++)
          await runStreamSample({ entryPath, mode, scenario });
        const samples = [];
        for (let n = 0; n < runs; n++)
          samples.push(await runStreamSample({ entryPath, mode, scenario }));
        const metrics =
          scenario === "interaction"
            ? {
                inputP95Ms: percentile(
                  samples.flatMap((sample) => sample.interaction.inputMs),
                  0.95,
                ),
              }
            : {
                streamP95Ms: percentile(
                  samples.flatMap((sample) =>
                    sample.latency.map((row) => row.ms),
                  ),
                  0.95,
                ),
                burstP95Ms: percentile(
                  samples.flatMap((sample) =>
                    sample.latency.map((row) => row.burstMs),
                  ),
                  0.95,
                ),
              };
        const budget = evaluateBudgets(
          metrics,
          scenario === "interaction" ? { inputP95Ms: 16 } : { streamP95Ms: 33 },
        );
        report.results.push({ mode, scenario, metrics, budget, samples });
        await saveReport(output, report);
        console.log(
          JSON.stringify({ mode, scenario, metrics, passed: budget.passed }),
        );
      }
    report.status = report.results.every((result) => result.budget.passed)
      ? "passed"
      : "failed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
  }
  report.endingEnvironment = environment();
  await saveReport(output, report);
  if (report.error || (check && report.status !== "passed"))
    process.exitCode = 1;
}
if (isMain(import.meta.url)) await main();
