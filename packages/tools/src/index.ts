import { realpath, readdir } from "node:fs/promises";
import { relative, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Plugin } from "../../core/src/types.ts";
import { resolvePath, allowedPath, updateTextFile } from "./workspace.ts";
import { readFileBytes, readTextFile } from "./secure-files.ts";
import { runProcess, runWorkspaceCommand, cleanProcessEnv } from "./process.ts";
export { resolvePath } from "./workspace.ts";
export { runProcess } from "./process.ts";
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
          const lines = (await readTextFile(p, ctx.signal)).split("\n");
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
          await updateTextFile(
            p,
            ctx.signal,
            (current) => {
              if (current !== undefined && expected !== current)
                throw Error(
                  "File changed or expected content missing. Read it before replacing.",
                );
              return content;
            },
            ctx.checkpoint,
          );
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
          await updateTextFile(
            p,
            ctx.signal,
            (old) => {
              if (old === undefined) throw Error("File does not exist");
              const index = old.indexOf(oldText);
              if (index < 0 || old.indexOf(oldText, index + 1) !== -1)
                throw Error("Expected exactly one match");
              return (
                old.slice(0, index) +
                newText +
                old.slice(index + oldText.length)
              );
            },
            ctx.checkpoint,
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
            ["--no-config", "--files", ...(glob ? ["-g", glob] : [])],
            ctx,
            { env: cleanProcessEnv() },
          );
        },
      });
      host.registerTool({
        name: "search",
        description: "Search project text with ripgrep; respects ignore files.",
        schema: z.object({ pattern: z.string(), glob: z.string().optional() }),
        async execute({ pattern, glob }, ctx) {
          // Enumerate names only, authorize each resource, then scan content.
          // A user glob must never override the file-reading permission policy.
          const files = await runProcess(
            "rg",
            ["--no-config", "--files", "-0", ...(glob ? ["-g", glob] : [])],
            ctx,
            { limit: 1_000_000, env: cleanProcessEnv() },
          );
          if (
            files.isError &&
            (files.data as { exitCode?: number })?.exitCode !== 1
          )
            return files;
          if (files.text.includes("[Output truncated"))
            throw Error("Search file list exceeds capacity; narrow the glob.");
          const paths: string[] = [];
          for (const path of files.text.split("\0").filter(Boolean))
            paths.push(
              await allowedPath(
                ctx,
                path,
                false,
                trusted(),
                options.reviewReads?.(),
              ),
            );
          let text = "";
          for (let offset = 0; offset < paths.length; offset += 8) {
            const results = await Promise.all(
              paths.slice(offset, offset + 8).map(async (path) => {
                await ctx.checkpoint?.();
                const input = await readFileBytes(
                  path,
                  ctx.signal,
                  16 * 1024 * 1024,
                );
                const result = await runProcess(
                  "rg",
                  [
                    "--no-config",
                    "-n",
                    "--no-filename",
                    "--max-count",
                    "30",
                    "--",
                    pattern,
                    "-",
                  ],
                  ctx,
                  { limit: 48000, env: cleanProcessEnv(), input },
                );
                if (!result.isError)
                  result.text =
                    result.text
                      .split("\n")
                      .filter(Boolean)
                      .map((line) => `${path}:${line}`)
                      .join("\n") + (result.text.endsWith("\n") ? "\n" : "");
                return result;
              }),
            );
            for (const result of results) {
              if (
                result.isError &&
                (result.data as { exitCode?: number })?.exitCode !== 1
              )
                return result;
              text += result.text.slice(0, Math.max(0, 48000 - text.length));
            }
            if (text.length >= 48000) break;
          }
          return { text, isError: false };
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
          return runWorkspaceCommand(command, ctx, {
            unrestricted,
            timeout: timeoutMs,
          });
        },
      });
      host.registerTool({
        name: "git_status",
        description: "Read Git status and diff summary.",
        schema: z.object({}),
        async execute(_, ctx) {
          if (
            options.reviewReads?.() &&
            !(await ctx.approve(
              "Read Git status, which may run repository filters and read sensitive workspace files",
            ))
          )
            throw Error("Permission denied");
          return runWorkspaceCommand(
            "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 git -c core.excludesFile=/dev/null -c core.attributesFile=/dev/null --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status --short --branch --ignore-submodules=all",
            ctx,
          );
        },
      });
      host.registerTool({
        name: "git_diff",
        description: "Read Git diff without external diff helpers.",
        schema: z.object({ staged: z.boolean().default(false) }),
        async execute({ staged }, ctx) {
          if (
            options.reviewReads?.() &&
            !(await ctx.approve(
              "Read Git diff, which may include sensitive workspace files",
            ))
          )
            throw Error("Permission denied");
          return runWorkspaceCommand(
            `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 git -c core.excludesFile=/dev/null -c core.attributesFile=/dev/null --no-pager --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --ignore-submodules=all${staged ? " --cached" : ""}`,
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
      const text = (
        await readTextFile(
          target.path,
          AbortSignal.timeout(10000),
          16 * 1024 * 1024,
        )
      ).slice(0, budget);
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
              const text = (
                await readTextFile(path, AbortSignal.timeout(10000))
              ).slice(0, 4096);
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
