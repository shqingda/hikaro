import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tuiRequire = createRequire(import.meta.resolve("@earendil-works/pi-tui"));

export function cliBuildOptions() {
  return {
    entryPoints: { hikaro: "apps/cli/src/launcher.ts" },
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
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    plugins: [
      {
        name: "startup-js-dependencies",
        setup(build) {
          // Bundle the measured startup graph, keeping optional SDKs and native
          // addons external. Resolve TUI's dependencies from its pnpm location.
          build.onResolve(
            {
              filter:
                /^(?:zod(?:\/.*)?|@earendil-works\/pi-tui|marked|get-east-asian-width)$/,
            },
            ({ path }) => ({
              path: ["marked", "get-east-asian-width"].includes(path)
                ? tuiRequire.resolve(path)
                : fileURLToPath(import.meta.resolve(path)),
            }),
          );
        },
      },
    ],
  };
}
