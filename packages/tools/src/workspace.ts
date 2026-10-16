import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  join,
} from "node:path";
import { randomUUID } from "node:crypto";
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
async function fileVersion(path: string) {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
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
    await mkdir(dirname(path), { recursive: true });
    const lockPath = path + ".hikaro-lock";
    const lock = await open(lockPath, "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw Error(
            `File update locked: ${lockPath}. Retry after the other writer finishes; after a crash, inspect the lock before removing it.`,
          );
        throw error;
      },
    );
    const temporary = join(
      dirname(path),
      `.${basename(path)}.hikaro-${randomUUID()}.tmp`,
    );
    try {
      await lock.writeFile(String(process.pid));
      const version = await fileVersion(path);
      const current =
        version === undefined ? undefined : await readFile(path, "utf8");
      const content = replace(current);
      const mode =
        version === undefined ? 0o666 : (await stat(path)).mode & 0o777;
      await writeFile(temporary, content, { flag: "wx", mode });
      await beforeCommit?.();
      if ((await fileVersion(path)) !== version)
        throw Error("File changed during editing. Read it before retrying.");
      signal.throwIfAborted();
      if (version === undefined) {
        // Exclusive creation also catches non-cooperating writers of new files.
        const { link } = await import("node:fs/promises");
        await link(temporary, path);
      } else await rename(temporary, path);
    } finally {
      try {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } finally {
        try {
          await lock.close();
        } finally {
          await unlink(lockPath);
        }
      }
    }
  } finally {
    release();
    if (fileUpdates.get(path) === pending) fileUpdates.delete(path);
  }
}
