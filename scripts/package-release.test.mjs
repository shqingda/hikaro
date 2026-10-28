import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as release from "./package-release.mjs";
const { releaseManifest } = release;
test("release package has explicit platform, executable and production-only dependencies", () => {
  const result = releaseManifest(
    {
      name: "hikaro",
      version: "0.1.0",
      engines: { node: ">=26.12.1" },
      dependencies: { foo: "1.2.3", zod: "4.6.7" },
      devDependencies: { bar: "9" },
      scripts: { postinstall: "compile source" },
    },
    "darwin",
    "arm64",
  );
  assert.deepEqual(result.dependencies, { foo: "1.2.3", zod: "4.6.7" });
  assert.deepEqual(result.overrides, {
    "@anthropic-ai/sandbox-runtime": { zod: "4.6.7" },
    "node-forge": "1.4.0",
  });
  assert.equal(result.devDependencies, undefined);
  assert.deepEqual(result.bin, { hikaro: "dist/hikaro.mjs" });
  assert.equal(result.scripts.postinstall, "node postinstall.mjs");
  assert.equal(result.private, true);
  assert.ok(result.files.includes("npm-shrinkwrap.json"));
  assert.deepEqual(result.os, ["darwin"]);
  assert.deepEqual(result.cpu, ["arm64"]);
  assert.deepEqual(result.bundledDependencies, [
    "@anthropic-ai/sandbox-runtime",
    "node-pty",
  ]);
  assert.throws(() => releaseManifest({}, "linux", "x64"));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hikaro-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const debug = join(root, "debug");
  const write = async (path, value) => {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), value);
  };
  return { root, stage, debug, write };
}

test("the packed release retains only its target PTY prebuild and separates exact build maps", async (t) => {
  const { root, stage, debug, write } = await fixture(t);
  const manifest = releaseManifest(
    {
      name: "hikaro-package-fixture",
      version: "0.0.0",
      dependencies: { "node-pty": "1.1.0", zod: "4.6.7" },
    },
    "darwin",
    "arm64",
  );
  await write("package.json", JSON.stringify(manifest));
  await write(
    "npm-shrinkwrap.json",
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
    }),
  );
  await write(
    "dist/hikaro.mjs",
    'console.log("ready");\n//# sourceMappingURL=hikaro.mjs.map\n',
  );
  const map = JSON.stringify({
    version: 3,
    sources: ["../src/index.ts"],
    sourcesContent: ['console.log("ready");'],
    names: [],
    mappings: "AAAA",
  });
  await write("dist/hikaro.mjs.map", map);
  await write("dist/nested/chunk.mjs.map", "nested map");
  await write(
    "node_modules/node-pty/package.json",
    JSON.stringify({
      name: "node-pty",
      version: "1.1.0",
      dependencies: { "node-addon-api": "7.1.1" },
    }),
  );
  await write(
    "node_modules/node-addon-api/package.json",
    JSON.stringify({ name: "node-addon-api", version: "7.1.1" }),
  );
  for (const name of [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "win32-arm64",
  ]) {
    await write(`node_modules/node-pty/prebuilds/${name}/pty.node`, name);
  }
  await write(
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    "helper",
  );
  for (const path of [
    "src/unix/pty.cc",
    "scripts/prebuild.js",
    "binding.gyp",
    "LICENSE",
    "third_party/conpty/conpty.dll",
  ]) {
    await write(`node_modules/node-pty/${path}`, path);
  }
  await write("node_modules/node-pty/prebuilds/README.md", "prebuild notes");
  await release.prepareReleaseStage(stage, debug);
  assert.deepEqual(
    (await readdir(join(stage, "node_modules/node-pty/prebuilds"))).sort(),
    ["README.md", "darwin-arm64"],
  );
  assert.equal(await readFile(join(debug, "dist/hikaro.mjs.map"), "utf8"), map);
  await assert.rejects(stat(join(stage, "dist/hikaro.mjs.map")), {
    code: "ENOENT",
  });
  assert.equal(
    execFileSync(
      process.execPath,
      ["--enable-source-maps", "dist/hikaro.mjs"],
      { cwd: stage, encoding: "utf8" },
    ).trim(),
    "ready",
  );

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
      { cwd: stage, encoding: "utf8" },
    ),
  )[0];
  const paths = packed.files.map((file) => file.path);
  assert.ok(
    paths.includes("node_modules/node-pty/prebuilds/darwin-arm64/pty.node"),
  );
  assert.ok(paths.includes("node_modules/node-addon-api/package.json"));
  for (const path of [
    "src/unix/pty.cc",
    "scripts/prebuild.js",
    "binding.gyp",
    "LICENSE",
    "third_party/conpty/conpty.dll",
  ]) {
    assert.ok(paths.includes(`node_modules/node-pty/${path}`), path);
  }
  assert.equal(
    paths.some((path) => path.endsWith(".map")),
    false,
  );
  assert.equal(
    paths.some((path) =>
      /prebuilds\/(?:darwin-x64|linux-x64|win32-arm64)\//.test(path),
    ),
    false,
  );
  const artifact = join(root, packed.filename);
  const sha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const metadata = await release.archiveDebugFiles(
    debug,
    join(root, "debug-output/fixture.debug.tgz"),
    { artifact, sha256, sourceCommit: "abc123", dirty: false },
  );
  assert.equal(
    metadata.sha256,
    createHash("sha256")
      .update(await readFile(metadata.artifact))
      .digest("hex"),
  );
  const debugManifest = JSON.parse(
    execFileSync("tar", ["-xOf", metadata.artifact, "manifest.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(debugManifest.release.sha256, sha256);
  assert.equal(debugManifest.release.sourceCommit, "abc123");
  assert.equal(
    debugManifest.files["dist/hikaro.mjs.map"],
    createHash("sha256").update(map).digest("hex"),
  );
  assert.equal(
    execFileSync("tar", ["-xOf", metadata.artifact, "dist/hikaro.mjs.map"], {
      encoding: "utf8",
    }),
    map,
  );
  assert.equal(
    (await readFile(metadata.artifact + ".sha256", "utf8")).split(/\s/)[0],
    metadata.sha256,
  );
});

test("release staging refuses a missing target PTY binary before pruning other platforms", async (t) => {
  const { stage, debug, write } = await fixture(t);
  await write(
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "foreign binary",
  );
  await assert.rejects(
    release.prepareReleaseStage(stage, debug),
    /darwin-arm64/,
  );
  assert.equal(
    await readFile(
      join(stage, "node_modules/node-pty/prebuilds/linux-x64/pty.node"),
      "utf8",
    ),
    "foreign binary",
  );
});

test("postinstall fixes the executable permission for both prebuilt and source-built PTY helpers", async (t) => {
  const { stage, write } = await fixture(t);
  await write("package.json", '{"type":"module"}');
  await write(
    "node_modules/node-pty/package.json",
    '{"name":"node-pty","version":"1.1.0"}',
  );
  await write("postinstall.mjs", release.releasePostinstall);
  for (const directory of ["prebuilds/darwin-arm64", "build/Release"]) {
    const path = `node_modules/node-pty/${directory}/spawn-helper`;
    await write(path, "helper");
    execFileSync(process.execPath, ["postinstall.mjs"], { cwd: stage });
    assert.equal((await stat(join(stage, path))).mode & 0o777, 0o755);
    await rm(join(stage, path));
  }
});
