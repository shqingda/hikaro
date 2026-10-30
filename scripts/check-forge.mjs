import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { verifyForge } from "./forge-release.mjs";
import { checkForgeSignatures } from "./forge-signatures.mjs";

const require = createRequire(
  process.argv[2] ? resolve(process.argv[2]) : import.meta.url,
);
const runtime = createRequire(require.resolve("@anthropic-ai/sandbox-runtime"));
const report = {
  status: "passed",
  scope: "installed official Node release and signature/PEM regression",
  ...(await verifyForge(dirname(runtime.resolve("node-forge/package.json")))),
  ...checkForgeSignatures(runtime("node-forge")),
};
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(
  resolve("artifacts/forge-release-evaluation.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
