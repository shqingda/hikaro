// Run with: node --import tsx scripts/bench-harness.mjs [--check]
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { join } from "node:path";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import {
  environment,
  evaluateBudgets,
  integerSetting,
  isMain,
  percentile,
  saveReport,
  withBenchmarkHome,
} from "./bench-support.mjs";

// These are regression ceilings for the fixed default workload, not promises
// about live provider latency or slower hardware. Keep the raw samples.
export const HARNESS_BUDGETS = {
  appendP95Ms: 1500,
  replayP95Ms: 100,
  messagePageP95Ms: 5,
  contextHistoryP95Ms: 25,
  streamP95Ms: 50,
  eventLoopP95Ms: 20,
  rssMaxMiB: 160,
};

export async function runHarnessSample({
  events = 10000,
  chunks = 10000,
  burstSize = 250,
  querySamples = 50,
} = {}) {
  for (const [name, value] of Object.entries({
    events,
    chunks,
    burstSize,
    querySamples,
  }))
    integerSetting(name, value, {}, 100000);
  return withBenchmarkHome(async (home) => {
    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    const delay = monitorEventLoopDelay({ resolution: 10 });
    let rssMaxMiB = process.memoryUsage().rss / 1024 ** 2;
    const sampleRss = () => {
      rssMaxMiB = Math.max(rssMaxMiB, process.memoryUsage().rss / 1024 ** 2);
    };
    const timer = setInterval(sampleRss, 10);
    timer.unref();
    delay.enable();
    try {
      const session = await store.createSession(home, "10k event history");
      const appendStart = performance.now();
      for (let ordinal = 0; ordinal < events; ordinal++) {
        const isMessage = ordinal % 10 === 0;
        await store.append(
          session.id,
          isMessage ? "message" : "text.delta",
          isMessage
            ? {
                ordinal,
                message: {
                  role: ordinal % 20 === 0 ? "user" : "assistant",
                  text: `fixture-message-${ordinal}`,
                  timestamp: ordinal,
                },
              }
            : { ordinal, text: `fixture-delta-${ordinal}` },
        );
      }
      const appendMs = performance.now() - appendStart;
      sampleRss();

      // Traverse the actual replay API. A fast run that drops or duplicates
      // committed events is a failure, regardless of its timing.
      const replayStart = performance.now();
      let cursor = 0;
      let replayedEvents = 0;
      while (true) {
        const page = await store.events(session.id, cursor, 1000);
        if (!page.length) break;
        assert.ok(page.length <= 1000);
        for (const event of page) {
          assert.ok(event.seq > cursor, "Replay sequence must advance");
          assert.equal(event.data.ordinal, replayedEvents);
          cursor = event.seq;
          replayedEvents++;
        }
      }
      const replayMs = performance.now() - replayStart;
      assert.equal(replayedEvents, events);
      assert.equal(await store.latestSeq(session.id), cursor);

      const querySamplesMs = [];
      let before;
      for (let i = 0; i < querySamples; i++) {
        const start = performance.now();
        const page = await store.messagePage(session.id, { before, limit: 20 });
        querySamplesMs.push(performance.now() - start);
        assert.ok(page.items.length > 0 && page.items.length <= 20);
        for (let j = 0; j < page.items.length; j++) {
          const item = page.items[j];
          assert.ok(before === undefined || item.seq < before);
          if (j) assert.ok(item.seq > page.items[j - 1].seq);
          assert.match(item.message.text, /^fixture-message-\d+$/);
        }
        before = page.hasOlder ? page.items[0].seq : undefined;
      }
      const historyStart = performance.now();
      const history = await store.contextHistory(session.id);
      const contextHistoryMs = performance.now() - historyStart;
      const historyMessages = Math.ceil(events / 10);
      assert.equal(history.messages.length, historyMessages);
      assert.equal(history.omitted, 0);

      const streamSession = await store.createSession(home, "Burst stream");
      const pieces = Array.from(
        { length: chunks },
        (_, i) => `chunk-${String(i).padStart(6, "0")};`,
      );
      const expected = pieces.join("");
      const provider = {
        id: "benchmark-fixture",
        model: "deterministic-burst",
        contextWindow: 32000,
        async *stream({ signal }) {
          for (let i = 0; i < pieces.length; i++) {
            signal.throwIfAborted();
            yield { type: "text", text: pieces[i] };
            // Yield between bursts so the fixture has a real event-loop input
            // path. There are no network calls or artificial token delays.
            if ((i + 1) % burstSize === 0) await immediate();
          }
          yield {
            type: "done",
            message: { role: "assistant", text: expected, timestamp: 1 },
            usage: { input: 1, output: chunks, cost: 0 },
          };
        },
      };
      const agent = new Agent({
        session: streamSession,
        store,
        provider,
        tools: new ToolRegistry(),
        approve: async () => false,
      });
      let observed = "";
      let previewMaxChars = 0;
      let emittedDeltas = 0;
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "text.delta") {
          emittedDeltas++;
          observed += event.data.text;
          previewMaxChars = Math.max(
            previewMaxChars,
            agent.snapshot().stream.length,
          );
        }
      });
      const streamStart = performance.now();
      try {
        await agent.prompt("Emit the deterministic benchmark fixture.");
      } finally {
        unsubscribe();
      }
      const streamMs = performance.now() - streamStart;
      assert.equal(observed, expected, "The live stream must not lose text");
      assert.ok(previewMaxChars <= 100000, "Preview memory must stay bounded");
      const streamMessages = await store.messages(streamSession.id);
      assert.equal(streamMessages.at(-1).text, expected);
      let persisted = "";
      let persistedStreamDeltas = 0;
      let completed = false;
      cursor = 0;
      while (true) {
        const page = await store.events(streamSession.id, cursor, 1000);
        if (!page.length) break;
        for (const event of page) {
          cursor = event.seq;
          if (event.type === "text.delta") {
            persisted += event.data.text;
            persistedStreamDeltas++;
          }
          if (event.type === "run.end")
            completed = event.data.status === "completed";
        }
      }
      assert.equal(persisted, expected, "Durable stream replay must match");
      assert.equal(persistedStreamDeltas, emittedDeltas);
      assert.equal(completed, true);
      assert.equal(agent.busy, false);
      sampleRss();
      return {
        metrics: {
          appendMs,
          replayMs,
          messagePageP95Ms: percentile(querySamplesMs, 0.95),
          contextHistoryMs,
          streamMs,
          // Very small custom workloads may finish before the first sample.
          eventLoopP95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
          rssMaxMiB,
        },
        querySamplesMs,
        correctness: {
          persistedEvents: events,
          replayedEvents,
          historyMessages,
          streamChunks: chunks,
          streamChars: expected.length,
          persistedStreamDeltas,
          previewMaxChars,
          streamTextMatches: true,
          streamCompleted: completed,
        },
      };
    } finally {
      clearInterval(timer);
      delay.disable();
      await store.close();
    }
  });
}

export async function main() {
  const env = process.env;
  const runs = integerSetting("HIKARO_HARNESS_RUNS", 3, env, 100);
  const warmups = integerSetting("HIKARO_HARNESS_WARMUPS", 1, env, 10, 0);
  const workload = {
    events: integerSetting("HIKARO_HARNESS_EVENTS", 10000, env),
    chunks: integerSetting("HIKARO_HARNESS_CHUNKS", 10000, env),
    burstSize: integerSetting("HIKARO_HARNESS_BURST_SIZE", 250, env),
    querySamples: integerSetting("HIKARO_HARNESS_QUERIES", 50, env, 1000),
  };
  const check = process.argv.includes("--check");
  if (
    check &&
    (workload.events !== 10000 ||
      workload.chunks !== 10000 ||
      workload.burstSize !== 250 ||
      workload.querySamples !== 50 ||
      runs < 3 ||
      warmups < 1)
  )
    throw Error(
      "--check requires the default workload, at least 3 runs and 1 warmup",
    );
  for (let i = 0; i < warmups; i++) await runHarnessSample(workload);
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await runHarnessSample(workload));
  const p95 = (name) =>
    percentile(
      samples.map((s) => s.metrics[name]),
      0.95,
    );
  const metrics = {
    appendP95Ms: p95("appendMs"),
    replayP95Ms: p95("replayMs"),
    messagePageP95Ms: percentile(
      samples.flatMap((s) => s.querySamplesMs),
      0.95,
    ),
    contextHistoryP95Ms: p95("contextHistoryMs"),
    streamP95Ms: p95("streamMs"),
    eventLoopP95Ms: samples.every((s) => s.metrics.eventLoopP95Ms !== null)
      ? p95("eventLoopP95Ms")
      : null,
    rssMaxMiB: Math.max(...samples.map((s) => s.metrics.rssMaxMiB)),
  };
  const budget = evaluateBudgets(metrics, HARNESS_BUDGETS);
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    kind: "sqlite-and-core-streaming",
    environment: environment(),
    runs,
    warmups,
    workload,
    metrics,
    budget,
    samples,
    limitations: [
      "Synthetic local fixtures; no live provider, network, external tools, terminal rendering.",
      "Fresh temporary SQLite database per sample; WAL and synchronous=FULL remain enabled. OS caches are warm.",
      "10k sequential durable appends include worker messaging and commit cost. Replay timings include correctness assertions.",
      "Burst streaming yields to the event loop every configured burst; it measures core persistence/coalescing, not token network pacing.",
      "RSS is sampled every 10ms and at stage boundaries and includes the SQLite worker and TypeScript loader; it is not an exact peak.",
      "Nearest-rank percentiles; default three measured runs provide a coarse regression signal, not statistical confidence or a 30-minute stability result.",
    ],
  };
  await saveReport(
    env.HIKARO_HARNESS_OUTPUT ?? "artifacts/benchmark-harness.json",
    report,
  );
  console.log(JSON.stringify(report, null, 2));
  if (check && !budget.passed) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
