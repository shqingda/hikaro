import { build } from "esbuild";
import { mkdir, copyFile, chmod, readdir, unlink } from "node:fs/promises";
import { buildSecureFileHelper } from "./build-native.mjs";
await buildSecureFileHelper();
await mkdir("dist", { recursive: true });
const result = await build({
  entryPoints: { hikaro: "apps/cli/src/index.ts" },
  outdir: "dist",
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: true,
  metafile: true,
});
await copyFile("packages/storage/src/worker.mjs", "dist/worker.mjs");
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
