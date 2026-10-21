import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isMain } from "./bench-support.mjs";

export function assessAudit(result) {
  const counts = result.metadata?.vulnerabilities;
  if (
    result.error ||
    !counts ||
    !["info", "low", "moderate", "high", "critical"].every(
      (k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0,
    )
  )
    throw Error(
      "Dependency audit unavailable or invalid; cannot approve release",
    );
  return {
    passed: counts.high === 0 && counts.critical === 0,
    vulnerabilities: counts,
  };
}
export function auditDirectory(directory) {
  let output;
  try {
    output = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    output = error.stdout;
  }
  const result = JSON.parse(output);
  return { ...assessAudit(result), result };
}
export async function auditArtifact(artifact) {
  const sha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const expected = (await readFile(artifact + ".sha256", "utf8")).split(
    /\s/,
  )[0];
  if (sha256 !== expected) throw Error("Artifact checksum mismatch");
  const directory = await mkdtemp(join(tmpdir(), "hikaro-release-audit-"));
  try {
    for (const file of ["package.json", "npm-shrinkwrap.json"]) {
      const content = execFileSync(
        "tar",
        ["-xOf", artifact, "package/" + file],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      JSON.parse(content.toString());
      await writeFile(join(directory, file), content);
    }
    const report = {
      artifact,
      sha256,
      measuredAt: new Date().toISOString(),
      scope: "tarball production dependency lock",
      ...auditDirectory(directory),
    };
    await writeFile(
      artifact + ".audit.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url)) {
  if (!process.argv[2])
    throw Error("Usage: node scripts/release-audit.mjs ARTIFACT.tgz");
  const report = await auditArtifact(resolve(process.argv[2]));
  console.log(
    JSON.stringify({
      passed: report.passed,
      sha256: report.sha256,
      vulnerabilities: report.vulnerabilities,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
