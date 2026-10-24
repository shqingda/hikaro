import { chmod, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  buildSecureFileHelper,
  buildProcessSnapshotHelper,
} from "./build-native.mjs";
await buildSecureFileHelper();
await buildProcessSnapshotHelper();
const require = createRequire(import.meta.url);
if (process.platform === "darwin") {
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = join(
    root,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  try {
    await access(helper);
    await chmod(helper, 0o755);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
