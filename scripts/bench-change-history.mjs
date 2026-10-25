import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ChangeJournal } from "../packages/tools/src/changes.ts";
import { ChangeObservations } from "../packages/tools/src/change-observations.ts";
import { ChangeReview } from "../packages/runtime/src/change-review.ts";
const session = "fixed-history";
const digest = createHash("sha256").update(session).digest("hex");
const home = await realpath(
  await mkdtemp(join(tmpdir(), "hikaro-history-bench-")),
);
const journalDir = join(home, "changes", digest);
const observationDir = join(home, "observations", digest);
const uuid = (n) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
try {
  await mkdir(journalDir, { recursive: true });
  await mkdir(observationDir, { recursive: true });
  for (let i = 0; i < 500; i++) {
    const common = {
      path: `/workspace/file-${i}.txt`,
      timestamp: i,
      before: "a".repeat(64),
      after: "b".repeat(64),
    };
    await writeFile(
      join(journalDir, uuid(i) + ".json"),
      JSON.stringify({
        id: uuid(i),
        ...common,
        state: "committed",
        origin: { callId: `call-${i}`, parentCallId: `wrapper-${i}` },
      }),
    );
    await writeFile(
      join(observationDir, uuid(i + 500) + ".json"),
      JSON.stringify({
        id: uuid(i + 500),
        ...common,
        after: (i < 250 ? "b" : "c").repeat(64),
        source: "shell",
        callId: i % 2 ? `wrapper-${i}` : `call-${i}`,
      }),
    );
  }
  for (let i = 0; i < 20; i++)
    await writeFile(
      join(observationDir, uuid(i) + ".coverage"),
      JSON.stringify([`warning-${i}`]),
    );
  const journal = new ChangeJournal(home),
    observations = new ChangeObservations(home);
  const review = new ChangeReview(
    { childTaskTree: async () => [] },
    journal,
    observations,
  );
  const time = async (run) => {
    const start = performance.now();
    await run();
    return +(performance.now() - start).toFixed(3);
  };
  const validate = async () => {
    const result = await review.list(session);
    if (result.items.length !== 750 || result.warnings.length !== 20)
      throw Error("fixture result changed");
  };
  await validate();
  const samples = [];
  for (let i = 0; i < 3; i++)
    samples.push({
      journalMs: await time(() => journal.list(session)),
      observationsMs: await time(() => observations.list(session)),
      coverageMs: await time(() => observations.warnings(session)),
      reviewMs: await time(validate),
    });
  console.log(
    JSON.stringify(
      {
        dataset: {
          journal: 500,
          observations: 500,
          coalesced: 250,
          coverage: 20,
        },
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

// Isolate coalescing from disk reads.
const journal = Array.from({ length: 5000 }, (_, i) => ({
  id: `journal-${i}`,
  path: `/workspace/file-${i}.txt`,
  timestamp: i,
  before: null,
  after: "a".repeat(64),
  state: "committed",
  origin: { callId: `call-${i}`, parentCallId: `wrapper-${i}` },
}));
const observations = journal.map((row, i) => ({
  ...row,
  id: `observed-${i}`,
  source: "shell",
  callId: i % 2 ? `wrapper-${i}` : `call-${i}`,
  after: (i < 2500 ? "a" : "b").repeat(64),
}));
const review = new ChangeReview(
  { childTaskTree: async () => [] },
  { list: async () => journal },
  { list: async () => observations, warnings: async () => [] },
);
const measure = async () => {
  const start = performance.now();
  const result = await review.list("root");
  if (result.items.length !== 7500) throw Error("result mismatch");
  return +(performance.now() - start).toFixed(3);
};
await measure();
const samples = [];
for (let i = 0; i < 5; i++) samples.push(await measure());
console.log(
  JSON.stringify({
    journal: 5000,
    observations: 5000,
    coalesced: 2500,
    mergeMs: samples,
  }),
);
