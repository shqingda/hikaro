#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import metadata from "../../../package.json" with { type: "json" };

// Node handles cache versioning, disabled/unwritable caches, and invalidation.
// Enable before loading application chunks; first launch still compiles them.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log(`hikaro ${metadata.version}`);
} else {
  enableCompileCache();
  await import("./index.ts");
}
