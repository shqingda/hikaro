import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tuiRequire = createRequire(import.meta.resolve("@earendil-works/pi-tui"));

export function cliBuildOptions() {
  return {
    entryPoints: { hikaro: "packages/cli/src/launcher.ts" },
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
    minifyIdentifiers: true,
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
                /^(?:zod(?:\/.*)?|@earendil-works\/pi-tui(?:\/.*)?|marked|marked-cjk-friendly|get-east-asian-width)$/,
            },
            ({ path }) => ({
              path: [
                "marked",
                "marked-cjk-friendly",
                "get-east-asian-width",
              ].includes(path)
                ? tuiRequire.resolve(path)
                : fileURLToPath(import.meta.resolve(path)),
            }),
          );
        },
      },
    ],
  };
}

// Pi supplies its own TUI classes and registries to extensions.
export function piExtensionBuildOptions() {
  return {
    ...cliBuildOptions(),
    entryPoints: { "pi-extension": "extensions/pi/index.ts" },
    splitting: false,
    plugins: [
      {
        name: "pi-host-tui",
        setup(build) {
          // The CLI lazily loads Markdown through CommonJS. An ESM extension
          // must import its host's constructor rather than dynamically require it.
          build.onResolve({ filter: /^\.\/markdown\.cjs$/ }, () => ({
            path: "host-markdown",
            namespace: "pi-host-markdown",
          }));
          build.onLoad({ filter: /.*/, namespace: "pi-host-markdown" }, () => ({
            contents:
              'import { Markdown } from "@earendil-works/pi-tui"; export function createMarkdown(...args) { return new Markdown(...args); }',
            loader: "js",
          }));
          // Shared Hikaro presentation imports pinned leaf modules in the CLI;
          // an extension must instead use the classes supplied by its Pi host.
          build.onResolve(
            { filter: /^@earendil-works\/pi-tui(?:\/.*)?$/ },
            () => ({
              path: "@earendil-works/pi-tui",
              external: true,
            }),
          );
        },
      },
    ],
  };
}
