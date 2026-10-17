import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as z from "zod";
import { resolvePath } from "./index.ts";
import type { Plugin } from "../../core/src/types.ts";
export const LspServers = z.record(
  z.string(),
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    extensions: z.array(z.string()),
  }),
);
class LspClient {
  private buffer = Buffer.alloc(0);
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private versions = new Map<string, number>();
  readonly diagnostics = new Map<string, any>();
  private child: ChildProcessWithoutNullStreams;
  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      env: Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      ),
    });
    this.child.stdout.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 2_000_000) {
        this.close();
        return;
      }
      for (;;) {
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split < 0) return;
        const length = Number(
          this.buffer
            .subarray(0, split)
            .toString()
            .match(/Content-Length:\s*(\d+)/i)?.[1],
        );
        if (!Number.isSafeInteger(length) || length > 1_000_000) {
          this.close();
          return;
        }
        if (this.buffer.length < split + 4 + length) return;
        const body = this.buffer.subarray(split + 4, split + 4 + length);
        this.buffer = this.buffer.subarray(split + 4 + length);
        try {
          const message = JSON.parse(body.toString());
          if (message.method === "textDocument/publishDiagnostics")
            this.diagnostics.set(message.params.uri, message.params);
          else if (message.id !== undefined) {
            const p = this.pending.get(message.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(message.id);
              message.error
                ? p.reject(Error(message.error.message))
                : p.resolve(message.result);
            } else if (message.method)
              this.send({ jsonrpc: "2.0", id: message.id, result: null });
          }
        } catch {
          this.close();
          return;
        }
      }
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.close());
    this.child.on("exit", () => this.close());
  }
  private send(value: unknown) {
    const text = JSON.stringify(value);
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.send({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        });
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          reject(Error("LSP request cancelled"));
        }
      };
      if (signal?.aborted) {
        reject(Error("Cancelled"));
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        reject(Error(`LSP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", cancel);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", cancel);
          reject(e);
        },
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  open(uri: string, text: string, languageId: string) {
    const previous = this.versions.get(uri);
    const version = (previous ?? 0) + 1;
    this.versions.set(uri, version);
    if (previous)
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    else
      this.notify("textDocument/didOpen", {
        textDocument: { uri, version, languageId, text },
      });
    return version;
  }
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("LSP connection closed"));
    }
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
  }
}
export function lspPlugin(servers: z.infer<typeof LspServers>): Plugin {
  return {
    id: "hikaro.lsp",
    apiVersion: 1,
    setup(host) {
      const clients = new Map<string, LspClient>();
      host.registerTool({
        name: "lsp",
        description:
          "Get definitions, references, symbols, or diagnostics from an explicitly configured language server. Lines/columns are 1-based; results use LSP 0-based positions.",
        schema: z.object({
          path: z.string(),
          operation: z.enum([
            "definition",
            "references",
            "symbols",
            "diagnostics",
          ]),
          line: z.number().int().min(1).default(1),
          column: z.number().int().min(1).default(1),
        }),
        async execute(args, ctx) {
          const resolved = await resolvePath(ctx.cwd, args.path);
          if (!resolved.inside)
            throw Error("LSP file must be inside the workspace");
          const entry = Object.entries(servers).find(([, v]) =>
            v.extensions.some((ext) => resolved.path.endsWith(ext)),
          );
          if (!entry)
            throw Error("No configured language server for this file");
          const [language, config] = entry;
          let client = clients.get(language);
          if (!client) {
            if (
              !(await ctx.approve(
                `Start language server ${config.command}. This configured server has host access.`,
              ))
            )
              throw Error("Permission denied");
            client = new LspClient(config.command, config.args, ctx.cwd);
            try {
              await client.request(
                "initialize",
                {
                  processId: process.pid,
                  rootUri: pathToFileURL(ctx.cwd).href,
                  capabilities: {
                    textDocument: {
                      publishDiagnostics: { versionSupport: true },
                    },
                  },
                },
                ctx.signal,
              );
              client.notify("initialized", {});
              clients.set(language, client);
            } catch (e) {
              client.close();
              throw e;
            }
          }
          const uri = pathToFileURL(resolved.path).href;
          const content = await readFile(resolved.path, "utf8");
          if (content.length > 1_000_000)
            throw Error("File exceeds LSP input limit");
          const version = client.open(uri, content, language);
          const params = {
            textDocument: { uri },
            position: { line: args.line - 1, character: args.column - 1 },
            context: { includeDeclaration: true },
          };
          let result: unknown;
          if (args.operation === "diagnostics") {
            await client.request(
              "textDocument/documentSymbol",
              { textDocument: { uri } },
              ctx.signal,
            );
            const diagnostics = client.diagnostics.get(uri);
            result = {
              ...diagnostics,
              requestedVersion: version,
              stale: diagnostics?.version !== version,
            };
          } else
            result = await client.request(
              `textDocument/${args.operation === "symbols" ? "documentSymbol" : args.operation}`,
              params,
              ctx.signal,
            );
          return {
            text: JSON.stringify(result ?? null),
            data: { uri, version, result },
          };
        },
      });
      return async () => {
        for (const c of clients.values()) c.close();
      };
    },
  };
}
