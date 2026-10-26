// Direction A: Hikaro PiBackend drives real Pi 1.4 over RPC against the fake model.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiBackend } from "/Users/shqingda/Projects/hikaro/packages/pi-bridge/src/index.ts";
import { startFake } from "./fake-llm.mjs";

const fake = await startFake();
const tmp = await mkdtemp(join(tmpdir(), "hk-pi-a-"));
const agentDir = join(tmp, "pi"),
  cwd = join(tmp, "ws"),
  sessions = join(tmp, "sessions");
await mkdir(agentDir);
await mkdir(cwd);
await mkdir(sessions);
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${fake.port}/v1`,
        api: "openai-completions",
        apiKey: "x",
        models: [{ id: "fake-1" }],
      },
    },
  }),
);
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
const SID = "00000000-0000-4000-8000-00000000a001";
const args = [
  "--provider",
  "fake",
  "--model",
  "fake-1",
  "--session-dir",
  sessions,
  "--session-id",
  SID,
  "--no-mcp",
  "--no-skills",
  "--no-extensions",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
];
const connect = () =>
  PiBackend.connect("pi", cwd, { args, env, onWarning: () => {} });
const results: string[] = [];
const ok = (s: string) => {
  results.push(s);
  console.log("PASS", s);
};
const events = (b: PiBackend) => {
  const e: any[] = [];
  b.subscribe((x) => e.push(x));
  return e;
};
try {
  // 1. Long session: 25 sequential turns.
  let b = await connect();
  let ev = events(b);
  const base = (await b.client.request("get_state", {}, true)).messageCount;
  const N = 25;
  for (let i = 1; i <= N; i++) await b.prompt(`turn ${i}`);
  let st = await b.client.request("get_state", {}, true);
  assert.equal(st.sessionId, SID);
  const conv = (
    await b.client.request("get_messages", {}, true)
  ).messages.filter((x: any) => x.role !== "system").length;
  assert.equal(conv, N * 2, `conversation ${conv}`);
  assert.ok(
    st.messageCount - base <= N * 2 + 1,
    `messageCount ${st.messageCount} base ${base}`,
  );
  assert.equal(fake.log.at(-1).users, N, "model saw full history");
  const ends = ev.filter((x) => x.type === "run.end");
  assert.equal(ends.length, N);
  assert.ok(ends.every((x) => x.data.status === "completed"));
  assert.ok(
    ev.some(
      (x) =>
        x.type === "text.delta" &&
        String(x.data.text).includes(`reply#${N} to: turn ${N}`),
    ),
  );
  ok(
    `long session: ${N} turns completed, Pi messages +${st.messageCount - base} (base ${base}), model saw ${fake.log.at(-1).users} user turns`,
  );

  // 2. Cancel mid-stream, then queued follow-up must not run; next prompt works.
  ev.length = 0;
  const p = b.prompt("slow please").catch((e) => e);
  await new Promise<void>((r) => {
    const t = setInterval(() => {
      if (ev.filter((x) => x.type === "text.delta").length >= 5) {
        clearInterval(t);
        r();
      }
    }, 20);
  });
  const q = b.prompt("queued follow-up").catch((e) => e);
  const t0 = Date.now();
  b.cancel();
  await Promise.race([
    p,
    new Promise((_, j) => setTimeout(() => j(Error("cancel hung")), 5000)),
  ]);
  await q;
  const cancelMs = Date.now() - t0;
  const end = ev.filter((x) => x.type === "run.end").at(-1);
  assert.equal(end?.data.status, "cancelled");
  const deltas = ev.filter((x) => x.type === "text.delta").length;
  assert.ok(deltas < 100, `stream stopped early (${deltas} deltas)`);
  assert.ok(
    !fake.log.some((x) => x.lastText === "queued follow-up"),
    "queued prompt was not sent",
  );
  await new Promise((r) => setTimeout(r, 300));
  const before = fake.log.length;
  await b.prompt("after cancel");
  assert.equal(fake.log.length, before + 1);
  assert.equal(
    ev.filter((x) => x.type === "run.end").at(-1).data.status,
    "completed",
  );
  ok(
    `cancel: stopped after ${deltas} deltas in ${cancelMs} ms, queued follow-up not sent, next turn completed`,
  );
  st = await b.client.request("get_state", {}, true);
  const countBeforeClose = st.messageCount;

  // 3. Resume: close the process, reconnect to the same session id.
  await b.close();
  b = await connect();
  ev = events(b);
  st = await b.client.request("get_state", {}, true);
  assert.equal(st.sessionId, SID);
  assert.equal(
    st.messageCount,
    countBeforeClose,
    `resumed messageCount ${st.messageCount} vs ${countBeforeClose}`,
  );
  await b.prompt("after resume");
  const last = fake.log.at(-1);
  assert.ok(
    last.users >= N + 2,
    `resumed request carried history (${last.users} users)`,
  );
  ok(
    `resume: reconnect kept session ${SID.slice(-4)} with ${countBeforeClose} messages; next request carried ${last.users} user turns`,
  );

  // 4. Pi process killed mid-run: backend reports failure, no hang.
  ev.length = 0;
  const p2 = b.prompt("slow again").catch((e) => e);
  await new Promise((r) => setTimeout(r, 400));
  (b.client as any).child?.kill?.("SIGKILL") ??
    (b.client as any).process?.kill?.("SIGKILL");
  const err = await Promise.race([
    p2,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 5000)),
  ]);
  assert.ok(
    err instanceof Error,
    `prompt rejected after kill (${String(err)})`,
  );
  assert.equal(
    ev.filter((x) => x.type === "run.end").at(-1)?.data.status,
    "failed",
  );
  await b.close().catch(() => {});
  b = await connect();
  st = await b.client.request("get_state", {}, true);
  assert.ok(
    st.messageCount >= countBeforeClose + 2,
    "session survives Pi crash",
  );
  await b.prompt("after crash");
  await b.close();
  ok(
    `crash: SIGKILL mid-run surfaced as failed (${(err as Error).message.slice(0, 60)}); reconnect resumed ${st.messageCount} messages`,
  );
} finally {
  fake.server.close();
  await rm(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
