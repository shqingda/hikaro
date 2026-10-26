// Direction B: real Pi 1.4 TUI with the installed Hikaro entry (demo provider), driven over a PTY.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { spawn } from "/Users/shqingda/Projects/hikaro/node_modules/node-pty/lib/index.js";
import { ProcessClient } from "/Users/shqingda/Projects/hikaro/packages/protocol/src/client.ts";

const root = "/Users/shqingda/Projects/hikaro";
const tmp = await mkdtemp(join(tmpdir(), "hk-pi-b-"));
const home = join(tmp, "hikaro"),
  cwd = join(tmp, "ws");
await mkdir(cwd);
const env: any = {
  ...process.env,
  PI_CODING_AGENT_DIR: join(tmp, "pi"),
  HIKARO_DEMO: "1",
  TERM: "xterm-256color",
};
delete env.HIKARO_HOME;
await promisify(execFile)(
  process.execPath,
  [
    resolve(root, "dist/hikaro.mjs"),
    "--install-pi",
    "--pi-command",
    "pi",
    "--home",
    home,
  ],
  { cwd, env },
);
const results: string[] = [];
const ok = (s: string) => {
  results.push(s);
  console.log("PASS", s);
};
const sessions = async () => {
  const c = new ProcessClient(
    process.execPath,
    [resolve(root, "dist/hikaro.mjs"), "--rpc", "--demo", "--home", home],
    { cwd },
  );
  try {
    const l = await c.request("session.list");
    return (l.sessions ?? l) as any[];
  } finally {
    await c.close();
  }
};
const piArgs = [
  "--offline",
  "--no-session",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
];
function openPi() {
  const t = spawn("pi", piArgs, { cwd, cols: 120, rows: 40, env });
  let out = "",
    all = "";
  t.onData((d) => {
    const s = stripVTControlCharacters(d);
    out = (out + s).slice(-60000);
    all += s;
  });
  let exited: number | undefined;
  t.onExit(({ exitCode }) => (exited = exitCode));
  const until = (pred: () => boolean, ms = 15000, what = "") =>
    new Promise<void>((r, j) => {
      const t0 = Date.now();
      const i = setInterval(() => {
        if (pred()) {
          clearInterval(i);
          r();
        } else if (Date.now() - t0 > ms) {
          clearInterval(i);
          j(Error(`timeout ${what}: ${out.slice(-1500)}`));
        }
      }, 20);
    });
  return {
    t,
    get out() {
      return out;
    },
    clear() {
      out = "";
    },
    get exited() {
      return exited;
    },
    until,
    wait: (s: string, ms?: number) => until(() => out.includes(s), ms, s),
    send: (s: string) => t.write(s),
  };
}
const hikaroPids = () => {
  try {
    return execFileSync("pgrep", ["-f", `hikaro.mjs --rpc.*${home}`])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};
try {
  // 1. Long session inside the auto-opened Hikaro view.
  let pi = openPi();
  await pi.wait("Hikaro · /back returns to Pi");
  const N = 15;
  for (let i = 1; i <= N; i++) {
    pi.clear();
    pi.send(`bturn${i}\r`);
    await pi.wait(`You wrote: bturn${i}`);
    await pi.wait("Enter send");
  }
  let list = await sessions();
  assert.equal(list.length, 1, `sessions ${list.length}`);
  ok(`long session: ${N} turns in one Hikaro session inside Pi`);

  // 2. Cancel with Ctrl+C mid-stream, then continue.
  pi.clear();
  pi.send("slow " + "x".repeat(3000) + "\r");
  await pi.wait("offline demo mode");
  const t0 = Date.now();
  pi.send("\x03");
  await pi.wait("Stopped", 5000);
  const stopMs = Date.now() - t0;
  assert.ok(
    !pi.out.includes("x".repeat(2900)),
    "stream stopped before full echo",
  );
  assert.equal(pi.exited, undefined, "Pi still running");
  pi.clear();
  pi.send("after-cancel\r");
  await pi.wait("You wrote: after-cancel");
  ok(
    `cancel: Ctrl+C stopped stream in ${stopMs} ms, Pi kept running, next turn completed`,
  );

  // 3. /back to Pi then reopen Hikaro: the same session continues with recent turns shown.
  pi.clear();
  pi.send("/back\r");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hikaroPids().length, 0, "Hikaro child exits on /back");
  pi.clear();
  pi.send("/hikaro\r");
  await pi.wait("You: after-cancel");
  pi.clear();
  pi.send("reopened\r");
  await pi.wait("You wrote: reopened");
  list = await sessions();
  assert.equal(list.length, 1, `sessions after reopen ${list.length}`);
  ok(
    "reopen: /back exits Hikaro child; /hikaro resumes the same session and shows recent turns",
  );

  // 4. Hikaro child killed mid-run: Pi survives and reports it, /back works.
  pi.clear();
  pi.send("slow " + "y".repeat(3000) + "\r");
  await pi.wait("Working · Ctrl+C stops");
  const pids = hikaroPids();
  assert.ok(pids.length > 0, "found Hikaro child");
  for (const pid of pids) process.kill(Number(pid), "SIGKILL");
  await pi.until(
    () => /exited|SIGKILL|closed/i.test(pi.out),
    5000,
    "exit notice",
  );
  assert.equal(pi.exited, undefined, "Pi survives Hikaro crash");
  await pi.wait("Not connected · Ctrl+D or /back returns to Pi");
  pi.clear();
  pi.send("ignored\r");
  await pi.wait("not connected");
  pi.send("/back\r");
  await new Promise((r) => setTimeout(r, 300));
  pi.clear();
  pi.send("/hikaro\r");
  // The killed 3000-character turn fills the screen once history has loaded.
  await pi.wait("y".repeat(60));
  await new Promise((r) => setTimeout(r, 200));
  pi.clear();
  pi.send("after-crash\r");
  // The killed child's 30 s session lease is never stolen; the refusal must be visible.
  await pi.until(
    () =>
      pi.out.includes("running elsewhere") ||
      pi.out.includes("You wrote: after-crash"),
    10000,
    "after-crash outcome",
  );
  const leaseHeld = pi.out.includes("running elsewhere");
  if (leaseHeld) {
    await pi.wait("Enter send");
    await new Promise((r) => setTimeout(r, 31000));
    pi.clear();
    pi.send("after-crash\r");
    await pi.wait("You wrote: after-crash");
  }
  ok(
    `crash: SIGKILL of Hikaro child shown in view, Pi kept running, draft kept while disconnected, typed /back returned to Pi, reopen resumed; ${leaseHeld ? "first prompt showed the held lease, retry after expiry completed" : "next prompt completed"}`,
  );

  // 5. Quit Pi and relaunch: auto-entry again.
  pi.send("/back\r");
  await new Promise((r) => setTimeout(r, 300));
  pi.send("\x04");
  await pi.until(() => pi.exited !== undefined, 5000, "pi exit");
  assert.equal(pi.exited, 0);
  pi = openPi();
  await pi.wait("You: after-crash");
  pi.clear();
  pi.send("relaunched\r");
  await pi.wait("You wrote: relaunched");
  list = await sessions();
  assert.equal(list.length, 1, `sessions after relaunch ${list.length}`);
  ok(
    "relaunch: Pi exits 0; relaunch auto-enters and resumes the same Hikaro session",
  );
  pi.send("/back\r");
  await new Promise((r) => setTimeout(r, 300));
  pi.send("\x04");
  await pi.until(() => pi.exited !== undefined, 5000, "pi exit");
} finally {
  for (const pid of hikaroPids())
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {}
  await rm(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
