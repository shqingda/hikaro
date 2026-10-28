// Public package scripts run ci:check first; keep packaging internals nonrecursive.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRelease } from "./package-release.mjs";
import { packageCli } from "./package-cli.mjs";

const mode = process.argv[2];
if (!["pack", "cli"].includes(mode)) throw Error("Expected pack or cli");
const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
await packageRelease();
execFileSync(
  "pnpm",
  [
    "check:release",
    join("artifacts/release", `hikaro-${version}-darwin-arm64.tgz`),
  ],
  { cwd: root, stdio: "inherit" },
);
if (mode === "cli") await packageCli({ reuseTgz: true });
