import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  readdir,
  rename,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { auditDirectory, auditArtifact } from "./release-audit.mjs";
import { isMain } from "./bench-support.mjs";
import { patchForge, assessPatchedAudit } from "./forge-patch.mjs";

export function releaseManifest(source, platform, arch) {
  if (platform !== "darwin" || arch !== "arm64")
    throw Error("Release packaging currently validated only for darwin-arm64");
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: "module",
    description: "Hikaro TUI local release candidate",
    engines: source.engines,
    os: [platform],
    cpu: [arch],
    bin: { hikaro: "dist/hikaro.mjs" },
    files: ["dist", "postinstall.mjs", "README.md", "npm-shrinkwrap.json"],
    scripts: { postinstall: "node postinstall.mjs" },
    dependencies: source.dependencies,
    // Preserve the source workspace's scoped security resolution in npm installs.
    overrides: {
      "@anthropic-ai/sandbox-runtime": { zod: source.dependencies.zod },
    },
    bundledDependencies: ["@anthropic-ai/sandbox-runtime", "node-pty"],
  };
}

export const releasePostinstall = `import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const pty = dirname(require.resolve('node-pty/package.json'));
try {
  await chmod(join(pty, 'prebuilds', 'darwin-arm64', 'spawn-helper'), 0o755);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await chmod(join(pty, 'build', 'Release', 'spawn-helper'), 0o755);
}
`;

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(directory, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

/** Only mutate the isolated npm staging tree, never development dependencies. */
export async function prepareReleaseStage(stage, debug) {
  const prebuilds = join(stage, "node_modules/node-pty/prebuilds");
  for (const file of ["pty.node", "spawn-helper"]) {
    const path = join(prebuilds, "darwin-arm64", file);
    if (!(await stat(path)).isFile())
      throw Error(`Invalid target PTY file: ${path}`);
  }
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name !== "darwin-arm64" &&
      /^(darwin|linux|win32|freebsd|openbsd|android|aix|sunos)-/.test(
        entry.name,
      )
    )
      await rm(join(prebuilds, entry.name), { recursive: true });
  }
  // Keep third-party package sources/scripts intact; these maps are from this build.
  for (const file of await filesBelow(join(stage, "dist"))) {
    if (!file.endsWith(".map")) continue;
    const destination = join(debug, "dist", file);
    await mkdir(dirname(destination), { recursive: true });
    await rename(join(stage, "dist", file), destination);
  }
}

export async function archiveDebugFiles(directory, artifact, release) {
  const files = {};
  for (const file of await filesBelow(directory)) {
    if (file.endsWith(".map"))
      files[file] = createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex");
  }
  if (!Object.keys(files).length)
    throw Error("Release build contains no source maps");
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        release: {
          artifact: basename(release.artifact),
          sha256: release.sha256,
          sourceCommit: release.sourceCommit,
          dirty: release.dirty,
        },
        files,
      },
      null,
      2,
    ) + "\n",
  );
  await mkdir(dirname(artifact), { recursive: true });
  execFileSync("tar", [
    "-czf",
    artifact,
    "-C",
    directory,
    "manifest.json",
    ...Object.keys(files),
  ]);
  const sha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  await writeFile(artifact + ".sha256", `${sha256}  ${basename(artifact)}\n`);
  return { artifact, sha256, files: Object.keys(files) };
}

export async function packageRelease() {
  const root = resolve(import.meta.dirname, "..");
  const stage = await mkdtemp(join(tmpdir(), "hikaro-package-"));
  const output = join(root, "artifacts", "release");
  await mkdir(output, { recursive: true });
  try {
    const source = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const manifest = releaseManifest(source, process.platform, process.arch);
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
    await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
    await writeFile(
      join(stage, "README.md"),
      await readFile(join(root, "docs/install-release.md")),
    );
    await writeFile(join(stage, "postinstall.mjs"), releasePostinstall);
    // Resolve once and ship the complete production dependency lock in the tarball.
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: stage, stdio: "inherit", timeout: 240000 },
    );
    await cp(
      join(stage, "package-lock.json"),
      join(stage, "npm-shrinkwrap.json"),
    );
    await patchForge(join(stage, "node_modules/node-forge"));
    const debug = join(stage, "debug");
    await prepareReleaseStage(stage, debug);
    const audit = await assessPatchedAudit(auditDirectory(stage), stage);
    await writeFile(
      join(output, "package-audit.json"),
      JSON.stringify(audit, null, 2) + "\n",
    );
    if (!audit.passed)
      throw Error(
        "Release blocked: high/critical production dependency vulnerabilities; see artifacts/release/package-audit.json",
      );
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", output], {
        cwd: stage,
        encoding: "utf8",
      }),
    )[0];
    if (!packed.files.some((file) => file.path === "npm-shrinkwrap.json"))
      throw Error("Packed artifact is missing its production dependency lock");
    const original = join(output, packed.filename);
    const artifact = join(
      output,
      `hikaro-${source.version}-${process.platform}-${process.arch}.tgz`,
    );
    await cp(original, artifact);
    await rm(original);
    const sha256 = createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex");
    const metadata = {
      artifact,
      sha256,
      compressedBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: Boolean(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ),
      files: packed.files.map((f) => f.path),
    };
    await writeFile(
      artifact + ".sha256",
      `${sha256}  ${artifact.split("/").at(-1)}\n`,
    );
    if (!(await auditArtifact(artifact)).passed)
      throw Error("Packed artifact security verification failed");
    // Keep *.tgz at the output root exclusive to installable candidates.
    metadata.debug = await archiveDebugFiles(
      debug,
      join(output, "debug", basename(artifact).replace(/\.tgz$/, ".debug.tgz")),
      metadata,
    );
    await writeFile(
      join(output, "manifest.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    console.log(JSON.stringify(metadata));
    return metadata;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url)) await packageRelease();
