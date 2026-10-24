import * as z from "zod";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin, ToolContext } from "../../core/src/types.ts";
import type { IPty } from "node-pty";
import { ProcessObservation } from "./process-observation.ts";
import { ProcessGroup } from "./process-group.ts";
import { cleanProcessEnv } from "./process.ts";
type TerminalRecord = {
  pty: IPty;
  processes: ProcessObservation;
  group: ProcessGroup;
  owner: string;
  command: string;
  output: string;
  dropped: number;
  preview: string;
  previewDropped: number;
  stopping: boolean;
  exitCode?: number;
  exitSignal?: number;
  cleanupConfirmed?: boolean;
  stopError?: string;
  stopTask?: Promise<void>;
};
export class TerminalManager {
  readonly records = new Map<string, TerminalRecord>();
  /** Notified after start, exit and stop outcomes so a host can keep a record. */
  onChange?: (id: string) => void;
  changed(id: string) {
    try {
      this.onChange?.(id);
    } catch {
      // Record keeping must never break terminal control.
    }
  }
  find(owner: string, id: string) {
    const term = this.records.get(id);
    if (!term || term.owner !== owner)
      throw Error("Terminal not found in this session");
    return term;
  }
  list(owner: string) {
    return [...this.records.keys()]
      .filter((id) => this.records.get(id)!.owner === owner)
      .map((id) => this.detail(owner, id));
  }
  detail(owner: string, id: string) {
    const t = this.find(owner, id);
    return {
      id,
      command: t.command,
      output: t.preview,
      dropped: t.previewDropped,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
      cleanup: t.stopError
        ? "failed"
        : t.cleanupConfirmed
          ? "confirmed"
          : t.stopping
            ? "pending"
            : "not requested",
      stopError: t.stopError,
      processNote: t.processes.note,
      state: t.stopError
        ? "stop_failed"
        : t.stopping && !t.cleanupConfirmed
          ? "stopping"
          : t.exitCode !== undefined
            ? t.processes.survivors.length
              ? "descendants_running"
              : t.processes.unresolved
                ? "descendants_unknown"
                : "exited"
            : "running",
    };
  }
  send(owner: string, id: string, input: string) {
    const t = this.find(owner, id);
    if (t.exitCode !== undefined || t.stopping)
      throw Error("Terminal is stopping or already exited");
    if (input.length > 32000) throw Error("Input exceeds 32,000 characters");
    t.pty.write(input);
  }
  stop(owner: string, id: string) {
    const t = this.find(owner, id);
    if (t.stopTask) return;
    if (t.cleanupConfirmed || (t.exitCode !== undefined && !t.stopping)) {
      // A completed group must never be signaled again using a recycled PGID.
      void t.processes.sample();
      return;
    }
    t.stopping = true;
    t.stopError = undefined;
    t.stopTask = this.stopGroup(t)
      .catch((error: unknown) => {
        t.stopError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        t.stopTask = undefined;
        const id = [...this.records].find(([, row]) => row === t)?.[0];
        if (id) this.changed(id);
        this.prune();
      });
  }
  private async stopGroup(t: TerminalRecord) {
    await t.processes.sample();
    await t.group.stop(() => t.exitCode !== undefined);
    t.cleanupConfirmed = true;
    await t.processes.sample();
  }
  prune() {
    const exited = [...this.records].filter(
      ([, t]) =>
        t.exitCode !== undefined &&
        (!t.stopping || t.cleanupConfirmed) &&
        !t.processes.unresolved,
    );
    for (const [id, t] of exited.slice(0, Math.max(0, exited.length - 32))) {
      void t.processes.close();
      this.records.delete(id);
    }
  }
}
export function terminalPlugin(
  trusted: boolean | (() => boolean),
  fullAccess: () => boolean = () => false,
  manager = new TerminalManager(),
): Plugin {
  return {
    id: "hikaro.terminal",
    apiVersion: 1,
    setup(host) {
      const terminals = manager.records;
      const find = (id: string, ctx: ToolContext) =>
        manager.find(ctx.sessionId, id);
      host.registerTool({
        name: "terminal_start",
        description:
          "Start an interactive/background command. Uses a workspace sandbox unless unrestricted or Full Access is selected. Expanded access follows the permission mode. Returns an ID for terminal_read, terminal_send, terminal_stop. Up to 8 live terminals.",
        schema: z.object({
          command: z.string().min(1).max(16000),
          unrestricted: z.boolean().default(false),
          cols: z.number().int().min(20).max(240).default(100),
          rows: z.number().int().min(5).max(100).default(30),
        }),
        async execute(args, ctx) {
          const unrestricted = args.unrestricted || fullAccess();
          if (
            [...terminals.values()].filter(
              (t) =>
                t.exitCode === undefined ||
                (t.stopping && !t.cleanupConfirmed) ||
                t.processes.unresolved,
            ).length >= 8
          )
            throw Error("Terminal concurrency limit reached");
          if (
            !(typeof trusted === "function" ? trusted() : trusted) ||
            unrestricted
          )
            if (
              !(await ctx.approve(
                `Start ${unrestricted ? "unrestricted" : "sandboxed"} terminal:\n${args.command}`,
              ))
            )
              throw Error("Permission denied");
          ctx.signal.throwIfAborted();
          const { spawn } = await import("node-pty");
          await ctx.checkpoint?.();
          ctx.signal.throwIfAborted();
          const env = cleanProcessEnv();
          const pty = unrestricted
            ? spawn("/bin/zsh", ["-f", "-c", args.command], {
                cwd: ctx.cwd,
                env,
                cols: args.cols,
                rows: args.rows,
              })
            : spawn(
                process.execPath,
                [
                  fileURLToPath(
                    new URL("./sandbox-runner.mjs", import.meta.url),
                  ),
                  args.command,
                  "--pty",
                ],
                { cwd: ctx.cwd, env, cols: args.cols, rows: args.rows },
              );
          const id = randomUUID();
          manager.prune();
          const term: TerminalRecord = {
            command: args.command,
            preview: "",
            previewDropped: 0,
            stopping: false,
            pty,
            group: new ProcessGroup(pty.pid),
            processes: new ProcessObservation(pty.pid, () =>
              manager.changed(id),
            ),
            owner: ctx.sessionId,
            output: "",
            dropped: 0,
            exitCode: undefined as number | undefined,
          };
          terminals.set(id, term);
          manager.changed(id);
          pty.onData((data) => {
            term.output += data;
            term.preview += data;
            if (term.preview.length > 64000) {
              term.previewDropped += term.preview.length - 64000;
              term.preview = term.preview.slice(-64000);
            }
            if (term.output.length > 64000) {
              term.dropped += term.output.length - 64000;
              term.output = term.output.slice(-64000);
            }
          });
          pty.onExit((event) => {
            term.exitCode = event.exitCode;
            term.exitSignal = event.signal;
            manager.changed(id);
            void term.processes.sample().then(() => manager.prune());
          });
          await term.processes.sample();
          return {
            text: `Terminal ${id} started. Read output with terminal_read; stop it explicitly when finished.`,
            data: { id },
          };
        },
      });
      host.registerTool({
        name: "terminal_read",
        description:
          "Read and consume bounded terminal output. Reports truncation and exit status.",
        schema: z.object({ id: z.string() }),
        async execute({ id }, ctx) {
          const t = find(id, ctx);
          const text = t.output;
          t.output = "";
          const dropped = t.dropped;
          t.dropped = 0;
          const detail = manager.detail(ctx.sessionId, id);
          const result = {
            text:
              (dropped ? `[${dropped} earlier characters omitted]\n` : "") +
              text,
            data: {
              id,
              exitCode: t.exitCode,
              running: detail.state !== "exited",
              state: detail.state,
              cleanup: detail.cleanup,
              processNote: detail.processNote,
              stopError: t.stopError,
              exitSignal: t.exitSignal,
              dropped,
            },
          };
          // Keep bounded completed records for user-visible result confirmation.
          return result;
        },
      });
      host.registerTool({
        name: "terminal_send",
        description:
          "Send text or control characters to an interactive terminal owned by this session.",
        schema: z.object({ id: z.string(), input: z.string().max(32000) }),
        async execute({ id, input }, ctx) {
          ctx.signal.throwIfAborted();
          manager.send(ctx.sessionId, id, input);
          return { text: "Input sent" };
        },
      });
      host.registerTool({
        name: "terminal_stop",
        description: "Stop an interactive or background terminal.",
        schema: z.object({ id: z.string() }),
        async execute({ id }, ctx) {
          manager.stop(ctx.sessionId, id);
          return { text: "Terminal stop requested" };
        },
      });
      return async () => {
        const pending = [...terminals.entries()];
        for (const [id, t] of pending) manager.stop(t.owner, id);
        await Promise.all(pending.map(([, t]) => t.stopTask));
        await Promise.all(pending.map(([, t]) => t.processes.close()));
        for (const [id, t] of pending) {
          if (t.stopError)
            console.error(`Terminal ${id} cleanup failed: ${t.stopError}`);
          else terminals.delete(id);
        }
      };
    },
  };
}
