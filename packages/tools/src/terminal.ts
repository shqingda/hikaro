import * as z from "zod";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin, ToolContext } from "../../core/src/types.ts";
import type { IPty } from "node-pty";
type TerminalRecord = {
  pty: IPty;
  owner: string;
  command: string;
  output: string;
  dropped: number;
  preview: string;
  previewDropped: number;
  stopping: boolean;
  exitCode?: number;
};
export class TerminalManager {
  readonly records = new Map<string, TerminalRecord>();
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
      state:
        t.exitCode !== undefined
          ? "exited"
          : t.stopping
            ? "stopping"
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
    if (t.exitCode !== undefined || t.stopping) return;
    t.pty.kill();
    t.stopping = true;
  }
  prune() {
    const exited = [...this.records].filter(
      ([, t]) => t.exitCode !== undefined,
    );
    for (const [id] of exited.slice(0, Math.max(0, exited.length - 32)))
      this.records.delete(id);
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
            [...terminals.values()].filter((t) => t.exitCode === undefined)
              .length >= 8
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
          const env = Object.fromEntries(
            ["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
              process.env[k] ? [[k, process.env[k]!]] : [],
            ),
          );
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
            owner: ctx.sessionId,
            output: "",
            dropped: 0,
            exitCode: undefined as number | undefined,
          };
          terminals.set(id, term);
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
            manager.prune();
          });
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
          const result = {
            text:
              (dropped ? `[${dropped} earlier characters omitted]\n` : "") +
              text,
            data: {
              id,
              exitCode: t.exitCode,
              running: t.exitCode === undefined,
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
        for (const t of terminals.values())
          if (t.exitCode === undefined) t.pty.kill();
        terminals.clear();
      };
    },
  };
}
