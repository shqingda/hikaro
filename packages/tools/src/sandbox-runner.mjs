import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { spawn } from "node:child_process";
import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cwd = realpathSync(process.cwd());
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "hikaro-exec-")));
process.env.TMPDIR = temporary;
const clean = () => rmSync(temporary, { recursive: true, force: true });
process.once("exit", clean);
try {
  if (process.platform !== "darwin")
    throw Error(
      "Workspace sandbox currently requires macOS. Use an explicitly approved unrestricted command.",
    );
  await SandboxManager.initialize({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: ["/"],
      allowRead: [
        cwd,
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/opt/homebrew",
        temporary,
        "/private/var/db",
        "/dev",
      ],
      allowWrite: [cwd, temporary],
      denyWrite: [`${cwd}/.git/hooks`, `${cwd}/.git/config`],
    },
    allowPty: process.argv.includes("--pty"),
    enableWeakerNetworkIsolation: false,
  });
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    process.argv[2],
    "/bin/zsh",
    undefined,
    undefined,
    cwd,
  );
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: "inherit" });
  child.once("error", async (e) => {
    console.error(e.message);
    await SandboxManager.reset();
    process.exitCode = 1;
  });
  child.once("exit", async (code) => {
    await SandboxManager.reset();
    process.exitCode = code ?? 1;
  });
} catch (e) {
  console.error(`Sandbox unavailable: ${e.message}`);
  await SandboxManager.reset();
  process.exitCode = 1;
}
