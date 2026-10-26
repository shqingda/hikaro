// Standalone macOS arm64 CLI: bundled Node runtime + the audited npm candidate, installed
// by distribution/install.sh with curl. Usage: node scripts/package-cli.mjs [--reuse-tgz]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMain } from "./bench-support.mjs";
import { packageRelease } from "./package-release.mjs";

export const NODE_VERSION = "26.12.1";
const platform = "darwin-arm64";

// Resolves the hikaro/hk symlinks to this release so the bundled runtime is used.
export const launcher = `#!/bin/sh
self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case $target in /*) self=$target ;; *) self=$(dirname "$self")/$target ;; esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
HIKARO_INSTALL_ROOT=$(cd "$root/../.." && pwd -P)
export HIKARO_INSTALL_ROOT
exec "$root/runtime/bin/node" "$root/app/node_modules/hikaro/dist/hikaro.mjs" "$@"
`;

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function nodeRuntime(work) {
  const name = `node-v${NODE_VERSION}-${platform}`;
  const archive = join(tmpdir(), `hikaro-${name}.tar.gz`);
  const sums = join(work, "SHASUMS256.txt");
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  execFileSync("curl", [
    "-fsSL",
    "--retry",
    "3",
    `${base}/SHASUMS256.txt`,
    "-o",
    sums,
  ]);
  const expected = (await readFile(sums, "utf8"))
    .split("\n")
    .find((line) => line.endsWith(`  ${name}.tar.gz`))
    ?.split(" ")[0];
  if (!expected) throw Error(`No published checksum for ${name}`);
  const cached = await stat(archive).then(
    async () => (await sha256(archive)) === expected,
    () => false,
  );
  if (!cached)
    execFileSync(
      "curl",
      ["-fL", "--retry", "3", `${base}/${name}.tar.gz`, "-o", archive],
      {
        stdio: "inherit",
      },
    );
  if ((await sha256(archive)) !== expected)
    throw Error("Node.js archive checksum mismatch");
  execFileSync("tar", ["-xzf", archive, "-C", work]);
  return join(work, name);
}

export async function packageCli({ reuseTgz = false } = {}) {
  const root = resolve(import.meta.dirname, "..");
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const tgz = join(
    root,
    "artifacts/release",
    `hikaro-${version}-${platform}.tgz`,
  );
  if (!reuseTgz) await packageRelease();
  const output = join(root, "artifacts/release/cli");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "hikaro-cli-"));
  try {
    const node = await nodeRuntime(work);
    const stage = join(work, "stage");
    await mkdir(join(stage, "runtime/bin"), { recursive: true });
    await mkdir(join(stage, "bin"));
    await mkdir(join(stage, "app"));
    await copyFile(join(node, "bin/node"), join(stage, "runtime/bin/node"));
    await chmod(join(stage, "runtime/bin/node"), 0o755);
    await copyFile(join(node, "LICENSE"), join(stage, "runtime/LICENSE"));
    // Install with the bundled runtime's own npm so native postinstall matches it.
    execFileSync(
      join(node, "bin/npm"),
      [
        "install",
        "--prefix",
        join(stage, "app"),
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--foreground-scripts",
        tgz,
      ],
      {
        stdio: "inherit",
        timeout: 600000,
        env: {
          ...process.env,
          PATH: `${join(node, "bin")}:${process.env.PATH}`,
        },
      },
    );
    const app = join(stage, "app/node_modules/hikaro");
    // npm may skip unapproved install scripts; the PTY helper must be executable either way.
    await chmod(
      join(app, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"),
      0o755,
    ).catch(() =>
      chmod(
        join(
          stage,
          "app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        ),
        0o755,
      ),
    );
    await writeFile(join(stage, "bin/hikaro"), launcher, { mode: 0o755 });
    const reported = execFileSync(join(stage, "bin/hikaro"), ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    }).trim();
    if (reported !== `hikaro ${version}`)
      throw Error(`Packaged CLI reports ${reported}, expected ${version}`);
    const asset = `hikaro-${version}-${platform}.tar.gz`;
    const archive = join(output, asset);
    execFileSync("tar", ["-czf", archive, "-C", stage, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const checksum = await sha256(archive);
    await copyFile(
      join(root, "distribution/install.sh"),
      join(output, "install.sh"),
    );
    await writeFile(
      join(output, `latest-${platform}.txt`),
      `${version} ${checksum} ${asset}\n`,
    );
    const sums = [];
    for (const file of [asset, "install.sh", `latest-${platform}.txt`])
      sums.push(`${await sha256(join(output, file))}  ${file}`);
    await writeFile(
      join(output, `hikaro-${version}-SHA256SUMS.txt`),
      sums.join("\n") + "\n",
    );
    const result = {
      version,
      asset: archive,
      sha256: checksum,
      bytes: (await stat(archive)).size,
      node: NODE_VERSION,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url))
  await packageCli({ reuseTgz: process.argv.includes("--reuse-tgz") });
