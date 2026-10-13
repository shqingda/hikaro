import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  readdir,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import type { Plugin, ToolContext, ToolResult } from "../../core/src/types.ts";
export async function resolvePath(cwd: string, input: string) {
  const root = await realpath(cwd);
  const target = resolve(root, input);
  let ancestor = target;
  const tails: string[] = [];
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      const path = resolve(actual, ...tails.reverse());
      const rel = relative(root, path);
      return {
        path,
        inside:
          rel === "" ||
          (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel)),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw e;
      tails.push(
        ancestor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)),
      );
      ancestor = parent;
    }
  }
}
async function allowedPath(
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
    (write && !trusted) ||
    (reviewRead && resolved.inside)
  ) {
    if (
      !(await ctx.approve(
        `${write ? "Write" : "Read"} ${resolved.path}${resolved.inside ? "" : " outside the workspace"}`,
      ))
    )
      throw Error("Permission denied");
  }
  return resolved.path;
}
export async function runProcess(
  command: string,
  args: string[],
  ctx: Pick<ToolContext, "cwd" | "signal" | "outputDirectory">,
  options: { timeout?: number; limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ToolResult> {
  ctx.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: ctx.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let text = "",
      truncated = false,
      timedOut = false,
      killing = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    let writer: WriteStream | undefined,
      artifact: string | undefined,
      archiveError: string | undefined;
    let archived = 0,
      archiveTruncated = false;
    const kill = () => {
      if (killing) return;
      killing = true;
      const signal = (name: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch {}
      };
      signal("SIGTERM");
      force = setTimeout(() => signal("SIGKILL"), 1000);
      force.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeout ?? 60000);
    ctx.signal.addEventListener("abort", kill, { once: true });
    const archive = (value: string) => {
      if (!writer || archiveError) return;
      const bytes = Buffer.from(value);
      const part = bytes.subarray(0, Math.max(0, 50 * 1024 * 1024 - archived));
      archived += part.length;
      archiveTruncated ||= part.length < bytes.length;
      if (part.length && !writer.write(part)) {
        child.stdout.pause();
        child.stderr.pause();
        writer.once("drain", () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    };
    const append = (value: string) => {
      const room = (options.limit ?? 48000) - text.length;
      if (value.length > room && !writer && ctx.outputDirectory) {
        artifact = join(ctx.outputDirectory, randomUUID() + ".log");
        writer = createWriteStream(artifact, { flags: "wx", mode: 0o600 });
        writer.on("error", (error) => {
          archiveError = error.message;
          child.stdout.resume();
          child.stderr.resume();
        });
        archive(text);
      }
      if (writer) archive(value);
      if (room > 0) text += value.slice(0, room);
      if (value.length > room) truncated = true;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const cleanup = () => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      ctx.signal.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      cleanup();
      writer?.destroy();
      reject(error);
    });
    child.on("close", async (code) => {
      cleanup();
      if (writer && !archiveError)
        await new Promise<void>((resolve) => {
          writer!.once("error", () => resolve());
          writer!.end(() => resolve());
        });
      resolveResult({
        text:
          text +
          (truncated
            ? `\n[Output truncated${artifact && !archiveError ? `; log: ${artifact}` : ""}]`
            : "") +
          (archiveTruncated ? "\n[Log limited to 50 MiB]" : "") +
          (archiveError ? `\n[Log unavailable: ${archiveError}]` : "") +
          (timedOut ? "\n[Timed out]" : "") +
          (ctx.signal.aborted ? "\n[Cancelled]" : ""),
        data: {
          exitCode: code,
          artifact: archiveError ? undefined : artifact,
          archiveTruncated,
        },
        isError: code !== 0 || timedOut || ctx.signal.aborted,
      });
    });
  });
}
export function codingPlugin(options: {
  trusted: boolean | (() => boolean);
  fullAccess?: () => boolean;
  reviewReads?: () => boolean;
}): Plugin {
  const trusted = () =>
    typeof options.trusted === "function" ? options.trusted() : options.trusted;
  return {
    id: "hikaro.coding",
    apiVersion: 1,
    setup(host) {
      host.registerTool({
        name: "read_file",
        description:
          "Read a text file with numbered lines. Use offset and limit for large files.",
        schema: z.object({
          path: z.string(),
          offset: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(1000).default(200),
        }),
        async execute({ path, offset, limit }, ctx) {
          const p = await allowedPath(
            ctx,
            path,
            false,
            trusted(),
            options.reviewReads?.(),
          );
          if ((await stat(p)).size > 2_000_000)
            throw Error(
              "File exceeds 2 MB. Use shell tools to inspect a bounded region.",
            );
          const lines = (await readFile(p, "utf8")).split("\n");
          return {
            text: lines
              .slice(offset - 1, offset - 1 + limit)
              .map((s, i) => `${offset + i}: ${s}`)
              .join("\n")
              .slice(0, 60_000),
            data: { path: p, totalLines: lines.length },
          };
        },
      });
      host.registerTool({
        name: "write_file",
        description:
          "Create or replace a text file. Existing files require expected content to prevent overwriting concurrent edits.",
        schema: z.object({
          path: z.string(),
          content: z.string().max(1_000_000),
          expected: z.string().optional(),
        }),
        async execute({ path, content, expected }, ctx) {
          const p = await allowedPath(ctx, path, true, trusted());
          let current: string | undefined;
          try {
            current = await readFile(p, "utf8");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          if (current !== undefined && expected !== current)
            throw Error(
              "File changed or expected content missing. Read it before replacing.",
            );
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, content, {
            flag: current === undefined ? "wx" : "w",
          });
          return {
            text: `Wrote ${relative(ctx.cwd, p)} (${Buffer.byteLength(content)} bytes)`,
          };
        },
      });
      host.registerTool({
        name: "edit_file",
        description: "Replace one exact, unique text match in a file.",
        schema: z.object({
          path: z.string(),
          oldText: z.string().min(1),
          newText: z.string(),
        }),
        async execute({ path, oldText, newText }, ctx) {
          const p = await allowedPath(ctx, path, true, trusted());
          const old = await readFile(p, "utf8");
          const index = old.indexOf(oldText);
          if (index < 0 || old.indexOf(oldText, index + oldText.length) !== -1)
            throw Error("Expected exactly one match");
          await writeFile(
            p,
            old.slice(0, index) + newText + old.slice(index + oldText.length),
          );
          return { text: `Updated ${relative(ctx.cwd, p)}` };
        },
      });
      host.registerTool({
        name: "list_files",
        description: "List project files with ripgrep; respects ignore files.",
        schema: z.object({ glob: z.string().optional() }),
        async execute({ glob }, ctx) {
          return runProcess(
            "rg",
            ["--files", ...(glob ? ["-g", glob] : [])],
            ctx,
          );
        },
      });
      host.registerTool({
        name: "search",
        description: "Search project text with ripgrep; respects ignore files.",
        schema: z.object({ pattern: z.string(), glob: z.string().optional() }),
        async execute({ pattern, glob }, ctx) {
          const result = await runProcess(
            "rg",
            [
              "-n",
              "--max-count",
              "30",
              ...(glob ? ["-g", glob] : []),
              "--",
              pattern,
              ".",
            ],
            ctx,
          );
          if ((result.data as any)?.exitCode === 1) result.isError = false;
          return result;
        },
      });
      host.registerTool({
        name: "shell",
        description:
          "Run a workspace sandboxed shell command without network. Set unrestricted when expanded access is necessary; approval depends on the selected permission mode. Full Access runs host commands without the sandbox.",
        schema: z.object({
          command: z.string().min(1).max(16000),
          timeoutMs: z.number().int().min(100).max(300000).default(60000),
          unrestricted: z.boolean().default(false),
        }),
        async execute({ command, timeoutMs, unrestricted }, ctx) {
          unrestricted ||= options.fullAccess?.() ?? false;
          if (unrestricted || !trusted()) {
            if (
              !(await ctx.approve(
                `Run ${unrestricted ? "unrestricted host" : "workspace sandbox"} command:\n${command}`,
              ))
            )
              throw Error("Permission denied");
          }
          const env = Object.fromEntries(
            ["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
              process.env[k] ? [[k, process.env[k]]] : [],
            ),
          );
          return unrestricted
            ? runProcess("/bin/zsh", ["-f", "-c", command], ctx, {
                timeout: timeoutMs,
              })
            : runProcess(
                process.execPath,
                [
                  fileURLToPath(
                    new URL("./sandbox-runner.mjs", import.meta.url),
                  ),
                  command,
                ],
                ctx,
                { timeout: timeoutMs, env },
              );
        },
      });
      host.registerTool({
        name: "git_status",
        description: "Read Git status and diff summary.",
        schema: z.object({}),
        async execute(_, ctx) {
          return runProcess(
            "git",
            ["--no-optional-locks", "status", "--short", "--branch"],
            ctx,
            { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
          );
        },
      });
      host.registerTool({
        name: "git_diff",
        description: "Read Git diff without external diff helpers.",
        schema: z.object({ staged: z.boolean().default(false) }),
        async execute({ staged }, ctx) {
          return runProcess(
            "git",
            [
              "--no-pager",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...(staged ? ["--cached"] : []),
            ],
            ctx,
          );
        },
      });
    },
  };
}
export type SkillResource = { name: string; description: string; path: string };
export type Resources = { skills: SkillResource[]; instructions: string[] };
export async function loadInstructions(
  cwd: string,
  report?: (resources: Resources) => void,
) {
  const sections: string[] = [];
  const resources: Resources = { skills: [], instructions: [] };
  let budget = 32000;
  for (const file of ["AGENTS.md", ".hikaro/AGENTS.md"]) {
    try {
      const target = await resolvePath(cwd, file);
      if (!target.inside) continue;
      const text = (await readFile(target.path, "utf8")).slice(0, budget);
      sections.push(`Workspace instructions (${file}):\n${text}`);
      resources.instructions.push(target.path);
      budget -= text.length;
    } catch {}
  }
  const seen = new Set<string>();
  const folders = [
    join(cwd, ".agents/skills"),
    join(cwd, ".hikaro/skills"),
    join(homedir(), ".agents/skills"),
    join(homedir(), ".hikaro/skills"),
  ];
  for (const folder of folders) {
    try {
      const root = await realpath(folder);
      const entries = await readdir(root, { withFileTypes: true });
      const discovered = await Promise.all(
        entries
          .filter((e) => e.isDirectory())
          .slice(0, 100)
          .map(async (entry) => {
            try {
              const path = await realpath(join(root, entry.name, "SKILL.md"));
              const rel = relative(root, path);
              if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
              const { open } = await import("node:fs/promises");
              const file = await open(path, "r");
              let text = "";
              try {
                const buffer = Buffer.alloc(4096);
                const { bytesRead } = await file.read(buffer, 0, 4096, 0);
                text = buffer.subarray(0, bytesRead).toString("utf8");
              } finally {
                await file.close();
              }
              return {
                name: entry.name,
                description:
                  text.match(/^description:\s*(.+)$/m)?.[1] ?? entry.name,
                path,
              };
            } catch {
              return undefined;
            }
          }),
      );
      for (const item of discovered) {
        if (item && !seen.has(item.name) && resources.skills.length < 100) {
          seen.add(item.name);
          resources.skills.push(item);
        }
      }
    } catch {}
  }
  if (resources.skills.length)
    sections.push(
      "Available skills (read the SKILL.md when needed):\n" +
        resources.skills
          .map((s) => `${s.name}: ${s.description} — read ${s.path} to apply.`)
          .join("\n")
          .slice(0, 16000),
    );
  report?.(resources);
  return sections.join("\n\n");
}
