// Explicit, billable subscription acceptance; never part of the default suite.
// node --import tsx scripts/check-live-release.mjs ARTIFACT.tgz
import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { verifyForge } from "./forge-patch.mjs";

const exec = promisify(execFile);
assert.ok(process.argv[2], "Pass the release tarball path");
const artifact = resolve(process.argv[2]);
const sha256 = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
assert.equal(
  sha256,
  (await readFile(artifact + ".sha256", "utf8")).split(/\s/)[0],
);
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, "artifacts"), { recursive: true });
const directory = await realpath(
  await mkdtemp(join(root, "artifacts/live-release-")),
);
const cwd = join(directory, "workspace");
const prefix = join(directory, "installed");
const cache = join(directory, "empty-cache");
// Keep the normal credential namespace so the installed app performs OAuth and
// persists token refresh itself. Only a newly created workspace/session is used.
const home = join(homedir(), ".hikaro");
const env = {
  ...process.env,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  TERM: "xterm-256color",
};
delete env.XAI_API_KEY;
const report = {
  status: "running",
  artifact,
  sha256,
  directory,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  authentication:
    "normal subscription credential store; XAI_API_KEY removed from child environment",
  startedAt: new Date().toISOString(),
  checks: [],
};
let step = "install",
  client,
  terminal,
  terminalExit,
  output = "";
const hosts = [],
  events = [];
const wait = async (condition, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(100);
  }
  throw Error("Timeout: " + label);
};
const waitText = (value, offset = 0) =>
  wait(
    () => stripVTControlCharacters(output.slice(offset)).includes(value),
    "TUI " + value,
  );
const submit = (value) => {
  const offset = output.length;
  terminal.write("\x1b[200~" + value + "\x1b[201~\r");
  return offset;
};
const exists = async (file) => {
  try {
    await readFile(join(cwd, file));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
try {
  await mkdir(cwd);
  await writeFile(join(directory, "npmrc"), "");
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--cache",
      cache,
      "--userconfig",
      join(directory, "npmrc"),
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    {
      cwd,
      env: { ...env, CI: "true" },
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const require = createRequire(
    join(prefix, "node_modules/hikaro/package.json"),
  );
  const runtime = createRequire(
    require.resolve("@anthropic-ai/sandbox-runtime"),
  );
  report.forge = await verifyForge(
    resolve(runtime.resolve("node-forge/package.json"), ".."),
    { distribution: true },
  );
  await exec(
    process.execPath,
    [
      join(root, "scripts/check-forge-fix.mjs"),
      join(prefix, "node_modules/hikaro/package.json"),
    ],
    { cwd: directory, timeout: 30000 },
  );
  const bin = join(prefix, "node_modules/.bin/hikaro");
  report.version = (await exec(bin, ["--version"], { cwd, env })).stdout.trim();
  report.checks.push(
    "empty-cache installed artifact, version and patched forge signatures",
  );
  console.log(
    "Installed " + report.version + "; starting real subscription TUI",
  );
  const packageSource = '{"private":true,"type":"commonjs"}\n';
  const testSource =
    "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {sum}=require('./sum.cjs'); test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1)});\n";
  await writeFile(join(cwd, "package.json"), packageSource);
  await writeFile(join(cwd, "sum.cjs"), "exports.sum = (a, b) => a - b;\n");
  await writeFile(join(cwd, "sum.test.cjs"), testSource);
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["add", "sum.cjs", "sum.test.cjs", "package.json"], {
    cwd,
  });
  const startHost = async () => {
    const child = spawnProcess(
      bin,
      [
        "--host",
        "--cwd",
        cwd,
        "--home",
        home,
        "--provider",
        "xai",
        "--model",
        "grok-4.7",
        "--trust",
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let ready = false;
    const host = {
      child,
      exit: new Promise((done) => child.once("exit", done)),
    };
    hosts.push(host);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (data) => {
      if (String(data).includes("shared host ready")) ready = true;
    });
    child.once("error", () => {
      host.failed = true;
    });
    await wait(() => {
      assert.ok(
        !host.failed && child.exitCode === null,
        "Installed host exited before ready",
      );
      return ready;
    }, "host startup");
    return host;
  };
  step = "host startup";
  const first = await startHost();
  client = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "release-observer",
  });
  await client.request("hello");
  const session = await client.request("session.create");
  report.sessionId = session.id;
  client.subscribe((frame) => {
    if (frame.type === "event") events.push(frame.event);
  });
  terminal = require("node-pty").spawn(
    bin,
    [
      "--attach",
      "--cwd",
      cwd,
      "--home",
      home,
      "--session",
      session.id,
      "--client-id",
      "release-tui",
    ],
    { cwd, env, cols: 110, rows: 40 },
  );
  terminal.onData((data) => {
    output += data;
  });
  terminalExit = new Promise((done) =>
    terminal.onExit(({ exitCode }) => done(exitCode)),
  );
  await waitText("/help");
  step = "real model read/edit/test/diff";
  const endAfter = (offset) =>
    events.slice(offset).find((event) => event.type === "run.end");
  const start = events.length;
  submit(
    "Release acceptance in this disposable workspace. Use read_file to read sum.cjs and sum.test.cjs, then edit_file or write_file to fix sum.cjs so it adds correctly. Do not modify the tests or package.json. Use shell to run exactly node --test sum.test.cjs and use git_diff to inspect the change. Finish with a brief description of what changed and the actual test result, including RELEASE-TOOLS-PASSED. Do not read outside this workspace, use network tools, install packages or delegate.",
  );
  await wait(() => endAfter(start), "real model completion", 120000);
  assert.equal(endAfter(start).data.status, "completed");
  const successful = events
    .slice(start)
    .filter((e) => e.type === "tool.end" && !e.data.result?.isError);
  for (const name of ["read_file", "shell", "git_diff"])
    assert.ok(
      successful.some((e) => e.data.name === name),
      "Missing tool: " + name,
    );
  assert.ok(
    successful.some((e) => ["write_file", "edit_file"].includes(e.data.name)),
    "Missing file edit",
  );
  assert.ok(
    events
      .slice(start)
      .some(
        (e) =>
          e.type === "tool.start" &&
          e.data.name === "shell" &&
          e.data.arguments?.command?.trim() === "node --test sum.test.cjs" &&
          successful.some((end) => end.data.callId === e.data.callId),
      ),
    "Model must execute requested test successfully",
  );
  await waitText("RELEASE-TOOLS-PASSED");
  assert.equal(await readFile(join(cwd, "sum.test.cjs"), "utf8"), testSource);
  assert.equal(
    await readFile(join(cwd, "package.json"), "utf8"),
    packageSource,
  );
  assert.equal(
    (await exec("git", ["diff", "--name-only"], { cwd })).stdout.trim(),
    "sum.cjs",
  );
  assert.equal(
    (
      await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd })
    ).stdout.trim(),
    "",
  );
  await exec(process.execPath, ["--test", "sum.test.cjs"], {
    cwd,
    timeout: 10000,
  });
  report.diff = (await exec("git", ["diff", "--", "sum.cjs"], { cwd })).stdout;
  report.checks.push(
    "installed TUI + subscription model reads, edits, tests and reviews diff; independent tests pass",
  );
  console.log("Real subscription tools passed");

  step = "TUI permission denial";
  const deny = submit("! --unrestricted touch denied-proof");
  await waitText("Permission required", deny);
  terminal.write("\x1b");
  await waitText("Manual command failed", deny);
  assert.equal(await exists("denied-proof"), false);
  report.checks.push(
    "TUI rejects unrestricted shell; denied command has no file side effect",
  );

  step = "real model cancellation";
  const cancelStart = events.length;
  submit(
    "Cancellation acceptance: call shell with exactly printf '%s' $$ > cancel.pid; printf started > cancel.started; sleep 60 and timeoutMs 90000. Do not run anything else or change other files. Wait for the tool result.",
  );
  await wait(
    () => exists("cancel.started"),
    "real model started shell",
    120000,
  );
  const pid = Number(await readFile(join(cwd, "cancel.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1 && alive(pid));
  terminal.write("\x03");
  await wait(() => endAfter(cancelStart), "cancellation terminal state");
  assert.equal(endAfter(cancelStart).data.status, "cancelled");
  await wait(() => !alive(pid), "cancelled shell process exits");
  report.checks.push(
    "Ctrl+C cancels real model shell; cancelled run and process exit both confirmed",
  );
  console.log("Permission denial and real model cancellation passed");

  step = "host crash with pending approval";
  const crashStart = events.length;
  const crashOffset = submit(
    "Recovery acceptance: call shell with command touch crash-proof and unrestricted true. Do not use any other tool, do not run a sandboxed alternative, and do not change any other file. Wait for permission.",
  );
  await waitText("Permission required", crashOffset);
  const beforeCrash = await client.request("session.current");
  assert.equal(beforeCrash.busy, true);
  assert.ok(
    beforeCrash.approvals.some(
      (a) => a.arguments.command === "touch crash-proof",
    ),
  );
  first.child.kill("SIGKILL");
  await first.exit;
  await client.close();
  client = undefined;
  await startHost();
  // The original host's lease must expire naturally; never force-unlock it.
  await delay(31000);
  client = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "release-observer",
  });
  await client.request("hello");
  await client.request("session.resume", { sessionId: session.id });
  const recovered = await client.request("session.current");
  assert.equal(recovered.busy, false);
  assert.equal(recovered.runStatus, "unknown");
  assert.equal(recovered.approvals.length, 0);
  assert.equal(await exists("crash-proof"), false);
  // No prompt is submitted until after recovery state and absence of side effects
  // are recorded. The installed TUI reconnects on its own.
  report.recovery = {
    beforeRunId: beforeCrash.runId,
    runId: recovered.runId,
    runStatus: recovered.runStatus,
  };
  assert.equal(recovered.runId, beforeCrash.runId);
  assert.equal(
    events.slice(crashStart).filter((e) => e.type === "run.start").length,
    1,
  );
  client.subscribe((frame) => {
    if (frame.type === "event") events.push(frame.event);
  });
  const resumeStart = events.length;
  submit(
    "The previous permission was not granted. Do not execute that command. No tools needed: reply exactly RELEASE-RECOVERY-PASSED.",
  );
  await wait(
    () => endAfter(resumeStart),
    "explicit subscription continuation",
    120000,
  );
  assert.equal(endAfter(resumeStart).data.status, "completed");
  await waitText("RELEASE-RECOVERY-PASSED", crashOffset);
  assert.equal(await exists("crash-proof"), false);
  report.checks.push(
    "SIGKILL during real model approval recovers unknown without executing command; explicit new TUI prompt succeeds",
  );
  terminal.write("\x04");
  assert.equal(await terminalExit, 0);
  terminal = undefined;
  report.checks.push("installed TUI clean exit");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failedStep = step;
  // Do not serialize child-process errors or provider payloads/credentials.
  report.error = {
    name: error.name,
    code: error.code,
    timedOut: error.killed === true,
  };
  if (error.name === "AssertionError" || error.message?.startsWith("Timeout:"))
    report.error.message = error.message;
  process.exitCode = 1;
} finally {
  terminal?.kill();
  if (terminalExit) await terminalExit;
  await client?.close();
  for (const host of hosts)
    if (host.child.exitCode === null && host.child.signalCode === null)
      host.child.kill("SIGTERM");
  await Promise.all(hosts.map((host) => host.exit));
  report.events = events
    .filter((e) =>
      ["run.start", "run.end", "tool.start", "tool.end"].includes(e.type),
    )
    .map((e) => ({
      type: e.type,
      name: e.data.name,
      status: e.data.status,
      isError: e.data.result?.isError,
    }));
  report.finishedAt = new Date().toISOString();
  report.limitations = [
    "current macOS arm64 machine",
    "physical IME not exercised",
    "provider rate limiting/network failure not injected",
    "not publicly published",
  ];
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await rm(prefix, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      status: report.status,
      failedStep: report.failedStep,
      error: report.error,
      checks: report.checks,
      report: join(directory, "report.json"),
    }),
  );
}
