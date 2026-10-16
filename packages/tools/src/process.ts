import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ToolContext, ToolResult } from "../../core/src/types.ts";
export function cleanProcessEnv() {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
}
export function runWorkspaceCommand(
  command: string,
  ctx: ToolContext,
  options: { unrestricted?: boolean; timeout?: number } = {},
) {
  return options.unrestricted
    ? runProcess("/bin/zsh", ["-f", "-c", command], ctx, {
        timeout: options.timeout,
      })
    : runProcess(
        process.execPath,
        [
          fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url)),
          command,
        ],
        ctx,
        { timeout: options.timeout, env: cleanProcessEnv() },
      );
}
export async function runProcess(
  command: string,
  args: string[],
  ctx: Pick<ToolContext, "cwd" | "signal" | "outputDirectory" | "checkpoint">,
  options: {
    timeout?: number;
    limit?: number;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
  } = {},
): Promise<ToolResult> {
  await ctx.checkpoint?.();
  ctx.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: ctx.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    let text = "",
      truncated = false,
      timedOut = false,
      killing = false;
    let terminated: Promise<void> | undefined;
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
      terminated = new Promise<void>((resolve) => {
        setTimeout(() => {
          signal("SIGKILL");
          resolve();
        }, 1000);
      });
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
      ctx.signal.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      cleanup();
      writer?.destroy();
      reject(error);
    });
    child.on("close", async (code) => {
      // The leader can close before descendants that ignored SIGTERM. Keep the
      // escalation alive and finish it before reporting cancellation complete.
      if (terminated) await terminated;
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
