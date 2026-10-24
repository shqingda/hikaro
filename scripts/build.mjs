import { build } from "esbuild";
import { mkdir, copyFile, chmod, readdir, unlink } from "node:fs/promises";
import { buildSecureFileHelper } from "./build-native.mjs";
import { cliBuildOptions } from "./build-options.mjs";
import { copyStorageWorker } from "./build-storage.mjs";
await buildSecureFileHelper();
await mkdir("dist", { recursive: true });
const result = await build(cliBuildOptions());
await copyStorageWorker("dist");
await copyFile(
  "packages/tools/src/secure-file-helper",
  "dist/secure-file-helper",
);
await chmod("dist/secure-file-helper", 0o755);
await copyFile(
  "packages/tools/src/sandbox-runner.mjs",
  "dist/sandbox-runner.mjs",
);
await chmod("dist/hikaro.mjs", 0o755);

await copyFile(
  "packages/tools/src/codemode-worker.mjs",
  "dist/codemode-worker.mjs",
);

// Prune only obsolete generated chunks, after all new outputs are ready.
const outputs = new Set(Object.keys(result.metafile.outputs));
for (const entry of await readdir("dist", { withFileTypes: true })) {
  const path = `dist/${entry.name}`;
  if (
    entry.isFile() &&
    /^chunk-[A-Z0-9]+\.mjs(?:\.map)?$/.test(entry.name) &&
    !outputs.has(path)
  ) {
    await unlink(path);
  }
}
