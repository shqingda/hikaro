import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PermissionRequest } from "../../core/src/types.ts";
import { resolvePath } from "../../tools/src/index.ts";
import { sensitivePath } from "../../tools/src/workspace.ts";

export const permissionModeSchema = z.enum(["ask", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
const savedSchema = z.record(z.string(), permissionModeSchema);
export const permissionOptions: Array<{
  value: PermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "ask",
    label: "Ask for approval",
    description:
      "Workspace edits and sandboxed commands; ask for outside access or unrestricted commands.",
  },
  {
    value: "auto",
    label: "Approve for me",
    description:
      "Approve known low-risk actions; ask for risky or unknown actions.",
  },
  {
    value: "full",
    label: "Full Access",
    description: "External files and network commands without approval.",
  },
];

async function savedModes(home: string) {
  try {
    return savedSchema.parse(
      JSON.parse(await readFile(join(home, "permissions.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadPermissionMode(
  home: string,
  cwd: string,
): Promise<PermissionMode> {
  return (await savedModes(home))[await realpath(cwd)] ?? "ask";
}

export async function savePermissionMode(
  home: string,
  cwd: string,
  mode: PermissionMode,
) {
  const next = permissionModeSchema.parse(mode);
  const key = await realpath(cwd);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const saved = await savedModes(home);
  const temporary = join(home, `.permissions-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ ...saved, [key]: next }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(home, "permissions.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}

function lowRiskCommand(command: unknown) {
  if (typeof command !== "string") return false;
  const words = command.trim().split(/\s+/);
  // Only literal arguments. No shell expansion, redirection, pipelines or scripts.
  if (!words.every((word) => /^[\w./:=,@%+-]+$/.test(word))) return false;
  if (words.some((word) => sensitivePath.test(word))) return false;
  const name = words.shift();
  if (name === "pwd") return words.length === 0;
  const flags: Record<string, Set<string>> = {
    ls: new Set(["-l", "-a", "-la", "-al", "-h", "-lah", "--"]),
  };
  const allowed = name ? flags[name] : undefined;
  // Content-reading shell commands cannot authorize individual paths or aliases.
  // Use the file tools for automatic per-resource approval instead.
  return (
    !!allowed &&
    words.every((word) => !word.startsWith("-") || allowed.has(word))
  );
}

export async function canAutoApprove(request: PermissionRequest, cwd: string) {
  if (request.capability?.kind === "file") {
    const resolved = await resolvePath(cwd, request.capability.path);
    return resolved.inside && !sensitivePath.test(resolved.path);
  }
  if (["read_file", "write_file", "edit_file"].includes(request.tool)) {
    const path = request.arguments.path;
    if (typeof path !== "string") return false;
    const resolved = await resolvePath(cwd, path);
    if (!resolved.inside) return false;
    return !sensitivePath.test(resolved.path);
  }
  if (request.tool === "shell" || request.tool === "terminal_start")
    return (
      request.arguments.unrestricted !== true &&
      lowRiskCommand(request.arguments.command)
    );
  if (request.tool === "browser")
    return ["snapshot", "screenshot", "close"].includes(
      String(request.arguments.action),
    );
  return false;
}
