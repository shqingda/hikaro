// Explicit subscription-login acceptance. Never included in the default test suite.
// Run: node --import tsx scripts/check-live-model.mjs
import { Runtime } from "../packages/runtime/src/index.ts";
import { createPiProvider } from "../packages/provider-pi/src/index.ts";
import { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import { KeychainCredentials } from "../packages/provider-pi/src/credentials.ts";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const credentials = new KeychainCredentials(join(homedir(), ".hikaro"));
const credential = await credentials.read("xai", {
  signal: AbortSignal.timeout(15000),
});
assert.ok(
  credential?.type === "oauth",
  "请先运行 pnpm start，在 /login 中选择 xAI → Sign in with SuperGrok or X Premium，完成订阅登录后再运行验收。无需 API Key。",
);
const catalog = new ProviderCatalog(join(homedir(), ".hikaro"), credentials);
const collection = await catalog.collection();
await mkdir(join(root, "artifacts"), { recursive: true });
const directory = await realpath(
  await mkdtemp(join(root, "artifacts/live-model-")),
);
const cwd = join(directory, "workspace");
const home = join(directory, "data");
await mkdir(cwd);
const packageSource = '{"private":true,"type":"commonjs"}\n';
await writeFile(join(cwd, "package.json"), packageSource);
await writeFile(join(cwd, "sum.cjs"), "exports.sum = (a, b) => a - b;\n");
await writeFile(
  join(cwd, "sum.test.cjs"),
  "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {sum}=require('./sum.cjs'); test('sum',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1)});\n",
);
await exec("git", ["init", "-q"], { cwd });
await exec("git", ["add", "sum.cjs", "sum.test.cjs", "package.json"], { cwd });
const testSource = await readFile(join(cwd, "sum.test.cjs"), "utf8");
const report = {
  status: "running",
  provider: "xai",
  model: "grok-4.7",
  authentication: "existing subscription OAuth via normal credential store",
  scope: "source Runtime and provider integration; not packaged CLI acceptance",
  directory,
  startedAt: new Date().toISOString(),
};
try {
  // Reuse the normal OAuth credential store, including refresh persistence.
  // Sessions, files and run events remain in the isolated acceptance directory.
  const runtime = await Runtime.open({
    cwd,
    home,
    trusted: true,
    provider: "xai",
    model: "grok-4.7",
    approve: async () => false,
  });
  try {
    runtime.plugins.providers.set("xai", () =>
      createPiProvider({
        provider: "xai",
        model: "grok-4.7",
        credentials,
        collection,
      }),
    );
    const session = await runtime.session();
    const agent = await runtime.agent(session);
    const timeout = setTimeout(() => agent.cancel(), 120000);
    try {
      await agent.prompt(
        "Release acceptance in this disposable workspace. Use read_file to read sum.cjs and sum.test.cjs, then edit_file or write_file to fix sum.cjs so it adds correctly. Do not modify the tests. Use shell to run exactly node --test sum.test.cjs and use git_diff to inspect the change. Finish with a brief description of what changed and the actual test result. Do not read outside this workspace, use network tools, install packages or delegate.",
      );
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await runtime.close();
  }
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
  const db = new DatabaseSync(join(home, "sessions.sqlite"), {
    readOnly: true,
  });
  try {
    const events = db
      .prepare("SELECT type,data FROM events ORDER BY seq")
      .all()
      .map((row) => ({ type: row.type, data: JSON.parse(row.data) }));
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
    report.usage = events
      .filter((e) => e.type === "run.end")
      .at(-1)?.data.usage;
    const successful = events.filter(
      (e) => e.type === "tool.end" && !e.data.result?.isError,
    );
    for (const name of ["read_file", "shell", "git_diff"])
      assert.ok(
        successful.some((e) => e.data.name === name),
        `Missing successful ${name} tool execution`,
      );
    assert.ok(
      successful.some((e) => ["write_file", "edit_file"].includes(e.data.name)),
      "Missing successful file edit",
    );
    const testCalls = events.filter(
      (e) =>
        e.type === "tool.start" &&
        e.data.name === "shell" &&
        e.data.arguments?.command?.trim() === "node --test sum.test.cjs",
    );
    assert.ok(
      testCalls.some((call) =>
        successful.some((end) => end.data.callId === call.data.callId),
      ),
      "Model did not successfully execute the requested test command",
    );
    assert.equal(
      events.filter((e) => e.type === "run.end").at(-1)?.data.status,
      "completed",
    );
    report.status = "passed";
    report.diff = (
      await exec("git", ["diff", "--", "sum.cjs"], { cwd })
    ).stdout;
    assert.ok(report.diff.includes("+"), "Missing reviewable change");
  } finally {
    db.close();
  }
} catch (error) {
  report.status = "failed";
  // exec errors can contain child environment/provider payloads: never serialize them.
  report.error = {
    name: error.name,
    code: error.code,
    timedOut: error.killed === true,
  };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
