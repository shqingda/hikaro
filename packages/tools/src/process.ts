import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ToolContext, ToolResult } from "../../core/src/types.ts";
import { ProcessGroup } from "./process-group.ts";
import { ProcessObservation } from "./process-observation.ts";
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
  options: { unrestricted?: boolean; timeout?: number; observe?: boolean } = {},
) {
  return options.unrestricted
    ? runProcess("/bin/zsh", ["-f", "-c", command], ctx, {
        timeout: options.timeout,
        observe: options.observe,
      })
    : runProcess(
        process.execPath,
        [
          fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url)),
          command,
        ],
        ctx,
        {
          timeout: options.timeout,
          env: cleanProcessEnv(),
          observe: options.observe,
        },
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
    observe?: boolean;
  } = {},
): Promise<ToolResult> {
  await ctx.checkpoint?.();
  ctx.signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: ctx.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const group = child.pid ? new ProcessGroup(child.pid) : undefined;
  const observation =
    options.observe && child.pid
      ? new ProcessObservation(child.pid)
      : undefined;
  let text = "",
    truncated = false,
    timedOut = false;
  let exited = false,
    closed = false,
    finishing = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | undefined, stopError: string | undefined;
  let terminated: Promise<void> | undefined;
  let cleanup = "not requested";
  let lifecycleDone!: () => void;
  const lifecycle = new Promise<void>((resolve) => {
    lifecycleDone = resolve;
  });
  let outputClosedDone!: () => void;
  const outputClosed = new Promise<void>((resolve) => {
    outputClosedDone = resolve;
  });
  let leaderExitedDone!: () => void;
  const leaderExited = new Promise<void>((resolve) => {
    leaderExitedDone = resolve;
  });
  let writer: WriteStream | undefined,
    artifact: string | undefined,
    archiveError: string | undefined;
  let archived = 0,
    archiveTruncated = false;
  // A bounded wait clears its timer even when the event wins immediately.
  const waitFor = async (event: Promise<void>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        event,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = () => {
    if (finishing || terminated) return;
    cleanup = "pending";
    terminated = (async () => {
      await observation?.sample();
      if (process.platform === "win32") {
        child.kill("SIGTERM");
        await waitFor(leaderExited, 1000);
        if (!exited) child.kill("SIGKILL");
        await waitFor(leaderExited, 2000);
        throw Error(
          "Only the direct child was signaled; process-group cleanup is unavailable on Windows",
        );
      }
      if (!group)
        throw Error(
          "Process identity unavailable; cleanup could not be confirmed",
        );
      await group.stop(() => exited);
      cleanup = "confirmed";
    })()
      .catch((error: unknown) => {
        cleanup = "failed";
        stopError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => lifecycleDone());
  };
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    leaderExitedDone();
    lifecycleDone();
  });
  child.once("close", () => {
    closed = true;
    outputClosedDone();
  });
  child.once("error", (error) => {
    spawnError = error;
    lifecycleDone();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout ?? 60000);
  ctx.signal.addEventListener("abort", stop, { once: true });
  if (ctx.signal.aborted) stop();
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
  void observation?.sample();
  await lifecycle;
  clearTimeout(timer);
  // Descendants can inherit stdout/stderr after the leader exits. Give pending
  // output a bounded drain window; waiting for `close` alone can hang forever.
  await waitFor(outputClosed, 1000);
  finishing = true;
  ctx.signal.removeEventListener("abort", stop);
  await terminated;
  await observation?.sample();
  await observation?.close();
  const outputIncomplete = !closed;
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  if (!exited) child.unref();
  if (spawnError) {
    writer?.destroy();
    throw spawnError;
  }
  if (writer && !archiveError) {
    let flushed = false;
    await waitFor(
      new Promise<void>((resolve) => {
        writer!.once("error", () => resolve());
        writer!.end(() => {
          flushed = true;
          resolve();
        });
      }),
      1000,
    );
    if (!flushed && !archiveError) archiveError = "Log flush timed out";
  }
  writer?.destroy();
  const processNote = observation?.note;
  const warnings = [
    timedOut ? "[Timed out]" : "",
    ctx.signal.aborted ? "[Cancelled]" : "",
    stopError
      ? `[Process-group cleanup failed: ${stopError}. Processes may still be running.]`
      : "",
    outputIncomplete
      ? "[Output incomplete: inherited streams did not close; remaining output and log may be missing.]"
      : "",
    observation?.unresolved ? `[${processNote}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    // Keep lifecycle conclusions before output so generic result truncation
    // cannot discard them. This is an observation at return, not later control.
    text:
      (warnings ? warnings + "\n" : "") +
      text +
      (truncated
        ? `\n[Output truncated${artifact && !archiveError ? `; log: ${artifact}` : ""}]`
        : "") +
      (archiveTruncated ? "\n[Log limited to 50 MiB]" : "") +
      (archiveError ? `\n[Log unavailable: ${archiveError}]` : ""),
    data: {
      exitCode,
      exitSignal,
      cleanup,
      stopError,
      outputIncomplete,
      processNote,
      artifact: archiveError ? undefined : artifact,
      archiveTruncated,
    },
    isError:
      exitCode !== 0 ||
      timedOut ||
      ctx.signal.aborted ||
      Boolean(stopError) ||
      outputIncomplete,
  };
}
