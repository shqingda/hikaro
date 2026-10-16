import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { replaceTextFile } from "./secure-files.ts";
import type { ToolContext } from "../../core/src/types.ts";

export const sensitivePath =
  /(?:^|\/)(?:\.git|\.ssh|\.aws|\.hikaro|\.env(?:\.[^/]*)?|\.npmrc|[^/]*(?:secret|credential|token|password)[^/]*|[^/]*\.(?:pem|key))(?:\/|$)/i;
const controlPath = /(?:^|\/)\.git(?:\/|$)/i;
export async function resolvePath(cwd: string, input: string) {
  const root = await realpath(cwd);
  let ancestor = resolve(root, input);
  const tails: string[] = [];
  for (;;) {
    try {
      const path = resolve(await realpath(ancestor), ...tails.reverse());
      const rel = relative(root, path);
      return {
        path,
        inside:
          rel === "" ||
          (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw e;
      tails.push(basename(ancestor));
      ancestor = parent;
    }
  }
}
export async function allowedPath(
  ctx: ToolContext,
  path: string,
  write: boolean,
  trusted: boolean,
  reviewRead = false,
) {
  const resolved = await resolvePath(ctx.cwd, path);
  if (
    (!resolved.inside &&
      !(!write && ctx.readonlyResources?.includes(resolved.path))) ||
    (write &&
      (!trusted ||
        controlPath.test(resolve(ctx.cwd, path)) ||
        controlPath.test(resolved.path))) ||
    (reviewRead && resolved.inside)
  ) {
    if (
      !(await ctx.approve(
        `${write ? "Write" : "Read"} ${resolved.path}${resolved.inside ? "" : " outside the workspace"}`,
        { kind: "file", path: resolved.path, write },
      ))
    )
      throw Error("Permission denied");
  }
  ctx.signal.throwIfAborted();
  return resolved.path;
}

// Canonical paths share a queue across plugin instances. The exclusive lock also
// coordinates independent Hikaro processes; it never expires underneath a writer.
const fileUpdates = new Map<string, Promise<void>>();
export async function updateTextFile(
  path: string,
  signal: AbortSignal,
  replace: (current: string | undefined) => string,
  beforeCommit?: () => Promise<void>,
) {
  const previous = fileUpdates.get(path);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileUpdates.set(path, pending);
  try {
    await previous;
    signal.throwIfAborted();
    await replaceTextFile(path, signal, replace, beforeCommit);
  } finally {
    release();
    if (fileUpdates.get(path) === pending) fileUpdates.delete(path);
  }
}
