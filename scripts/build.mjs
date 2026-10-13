import { build } from "esbuild";
import { mkdir, copyFile, chmod } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
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
});
await copyFile("packages/storage/src/worker.mjs", "dist/worker.mjs");
await copyFile(
  "packages/tools/src/sandbox-runner.mjs",
  "dist/sandbox-runner.mjs",
);
await chmod("dist/hikaro.mjs", 0o755);

await copyFile(
  "packages/tools/src/codemode-worker.mjs",
  "dist/codemode-worker.mjs",
);
