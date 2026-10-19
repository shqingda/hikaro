#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Node handles cache versioning, disabled/unwritable caches, and invalidation.
// Enable before loading application chunks; first launch still compiles them.
enableCompileCache();
await import("./index.ts");
