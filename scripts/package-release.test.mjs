import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseManifest } from "./package-release.mjs";
test("release package has explicit platform, executable and production-only dependencies", () => {
  const result = releaseManifest(
    {
      name: "hikaro",
      version: "0.1.0",
      engines: { node: ">=26.12.1" },
      dependencies: { foo: "1.2.3" },
      devDependencies: { bar: "9" },
      scripts: { postinstall: "compile source" },
    },
    "darwin",
    "arm64",
  );
  assert.deepEqual(result.dependencies, { foo: "1.2.3" });
  assert.equal(result.devDependencies, undefined);
  assert.deepEqual(result.bin, { hikaro: "dist/hikaro.mjs" });
  assert.equal(result.scripts.postinstall, "node postinstall.mjs");
  assert.equal(result.private, true);
  assert.ok(result.files.includes("npm-shrinkwrap.json"));
  assert.deepEqual(result.os, ["darwin"]);
  assert.deepEqual(result.cpu, ["arm64"]);
  assert.throws(() => releaseManifest({}, "linux", "x64"));
});
