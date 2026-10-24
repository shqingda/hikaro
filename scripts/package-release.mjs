import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    bundledDependencies: ["@anthropic-ai/sandbox-runtime"],
  };
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
    await writeFile(
      join(stage, "postinstall.mjs"),
      `import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
await chmod(join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', 'darwin-arm64', 'spawn-helper'), 0o755);
`,
    );
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
