import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { verifyForge } from "./forge-patch.mjs";

const mobile = createRequire(
  new URL("../apps/mobile/package.json", import.meta.url),
);
const expo = createRequire(mobile.resolve("expo/package.json"));
const plugins = createRequire(
  expo.resolve("@expo/config-plugins/package.json"),
);
const xcode = createRequire(plugins.resolve("xcode/package.json"));

test("Xcode's resolved UUID rejects partial buffer writes before mutation", () => {
  const uuid = xcode("uuid");
  for (const method of [uuid.v3, uuid.v5]) {
    for (const [size, offset] of [
      [8, 0],
      [16, 1],
      [16, -1],
    ]) {
      const bytes = new Uint8Array(size).fill(0xaa);
      assert.throws(
        () => method("test", uuid.v5.DNS, bytes, offset),
        RangeError,
      );
      assert.ok(bytes.every((byte) => byte === 0xaa));
    }
  }
});

test("Xcode still creates unique 24-digit group/file IDs and serializes them", () => {
  const project = plugins("xcode").project("in-memory.pbxproj");
  project.hash = {
    project: {
      archiveVersion: 1,
      objectVersion: 56,
      objects: { PBXGroup: {}, PBXFileReference: {}, PBXBuildFile: {} },
    },
  };
  const group = project.addPbxGroup(["Example.swift"], "Sources", "Sources");
  const ids = project.allUuids();
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-F0-9]{24}$/);
  const serialized = project.writeSync();
  const parsed = xcode("./lib/parser/pbxproj").parse(serialized);
  assert.deepEqual(
    parsed.project.objects.PBXGroup[group.uuid].children,
    project.hash.project.objects.PBXGroup[group.uuid].children,
  );
});

test("both Expo signing paths resolve the fully verified forge Node implementation", async () => {
  const cli = createRequire(expo.resolve("@expo/cli/package.json"));
  const signing = createRequire(
    cli.resolve("@expo/code-signing-certificates/package.json"),
  );
  for (const consumer of [cli, signing]) {
    await verifyForge(dirname(consumer.resolve("node-forge/package.json")));
  }
});
