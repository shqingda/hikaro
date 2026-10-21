import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { verifyForge } from "./forge-patch.mjs";

const exec = promisify(execFile);
if (!process.argv[2])
  throw Error("Usage: node scripts/check-release.mjs ARTIFACT.tgz");
// The bin shebang and npm must use the runtime being evaluated.
const childNode = (
  await exec("node", ["-p", "process.execPath"])
).stdout.trim();
assert.equal(
  await realpath(childNode),
  await realpath(process.execPath),
  "PATH node differs from validation runtime",
);
const artifact = resolve(process.argv[2]);
const expected = (await readFile(artifact + ".sha256", "utf8")).split(/\s/)[0];
const sha256 = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
assert.equal(sha256, expected, "Artifact checksum mismatch");
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "hikaro-release-install-")),
);
const prefix = join(temporary, "installed");
const home = join(temporary, "data");
const workspace = join(temporary, "workspace");
try {
  await mkdir(workspace);
  await writeFile(join(temporary, "npmrc"), "");
  const installed = await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--cache",
      join(temporary, "empty-cache"),
      "--userconfig",
      join(temporary, "npmrc"),
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    {
      cwd: workspace,
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        CI: "true",
      },
    },
  );
  process.stdout.write(installed.stdout);
  process.stderr.write(installed.stderr);
  const require = createRequire(
    join(prefix, "node_modules/hikaro/package.json"),
  );
  const { spawn } = require("node-pty");
  const runtime = createRequire(
    require.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const forge = await verifyForge(
    resolve(runtime.resolve("node-forge/package.json"), ".."),
    { distribution: true },
  );
  await exec(
    process.execPath,
    [
      resolve(import.meta.dirname, "check-forge-fix.mjs"),
      join(prefix, "node_modules/hikaro/package.json"),
    ],
    { cwd: workspace, timeout: 30000 },
  );
  const bin = join(prefix, "node_modules/.bin/hikaro");
  assert.equal(
    (await exec(bin, ["--version"])).stdout.trim(),
    "hikaro " + require("./package.json").version,
  );
  const result = await exec(
    bin,
    [
      "--demo",
      "--new",
      "--home",
      home,
      "--cwd",
      workspace,
      "--prompt",
      "release-install-marker",
    ],
    { cwd: workspace, timeout: 30000 },
  );
  assert.match(result.stdout, /release-install-marker/);
  const markerFile = join(workspace, "native-read.txt");
  await writeFile(markerFile, "native-helper-marker");
  const native = await exec(
    join(prefix, "node_modules/hikaro/dist/secure-file-helper"),
    ["read", markerFile, "1024"],
    { cwd: workspace, timeout: 5000 },
  );
  assert.match(native.stdout, /native-helper-marker/);
  const terminal = spawn(bin, ["--demo", "--home", home, "--cwd", workspace], {
    cwd: workspace,
    cols: 100,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  await new Promise((done, reject) => {
    let output = "",
      ready = false;
    const timer = setTimeout(() => {
      terminal.kill();
      reject(
        Error(
          "Installed TUI timeout: " +
            stripVTControlCharacters(output).slice(-2000),
        ),
      );
    }, 15000);
    terminal.onData((data) => {
      output = (output + data).slice(-16000);
      if (!ready && stripVTControlCharacters(output).includes("/help")) {
        ready = true;
        terminal.write("\x04");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (ready && exitCode === 0) done();
      else reject(Error(`Installed TUI exit=${exitCode}, ready=${ready}`));
    });
  });
  const report = {
    status: "passed",
    sha256,
    artifact,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeExecutable: process.execPath,
    emptyNpmCache: true,
    forge,
    checks: [
      "artifact checksum",
      "npm install --engine-strict",
      "installed forge complete Node implementation matches source patch",
      "installed forge accepts valid signatures and rejects malformed DigestAlgorithm (8 cases)",
      "installed bin version",
      "installed bin demo prompt",
      "packaged native file helper read",
      "installed node-pty TUI startup and clean exit",
    ],
    limitations: [
      "current macOS developer machine",
      "real provider and Keychain not exercised",
      "not signed/notarized or publicly published",
    ],
    finishedAt: new Date().toISOString(),
  };
  await writeFile(
    artifact + ".validation.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
