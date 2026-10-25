import * as z from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv } from "ajv";
import type { Plugin, Tool } from "../../core/src/types.ts";
const Server = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ url: z.url() }),
]);
export const MCPConfig = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), Server);
const actionSchema = z.enum(["connect", "disconnect", "reconnect", "refresh"]);
type ServerState = {
  client?: Client;
  tools: Tool[];
  active: number;
  operation?: z.infer<typeof actionSchema>;
  error?: string;
};

export function mcpPlugin(servers: z.infer<typeof MCPConfig>): Plugin {
  return {
    id: "hikaro.mcp",
    apiVersion: 1,
    setup(host) {
      const states = new Map(
        Object.keys(servers).map((name) => [
          name,
          { tools: [], active: 0 } as ServerState,
        ]),
      );
      const lifecycle = new AbortController();
      const closing = new Set<Promise<void>>();
      const status = () =>
        [...states]
          .map(
            ([name, state]) =>
              `${name}: ${state.operation ?? (state.client ? "connected" : "disconnected")} · ${state.tools.length} tools · ${state.active} active calls${state.error ? ` · ${state.error}` : ""}`,
          )
          .join("\n") || "No MCP servers configured.";
      const unregister = (state: ServerState) => {
        host.unregisterTools(state.tools.map((tool) => tool.name));
        state.tools = [];
      };
      const stop = async (state: ServerState) => {
        const client = state.client;
        state.client = undefined;
        unregister(state);
        await client?.close();
      };
      const current = (
        state: ServerState,
        client: Client,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        lifecycle.signal.throwIfAborted();
        if (state.client !== client)
          throw Error("MCP connection is disconnected or stale");
      };
      const discover = async (
        server: string,
        state: ServerState,
        client: Client,
        signal: AbortSignal,
      ) => {
        const ajv = new Ajv({ strict: false });
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const tools: Tool[] = [];
        do {
          current(state, client, signal);
          const response = await client.listTools(
            cursor ? { cursor } : undefined,
            { signal, timeout: 15000 },
          );
          current(state, client, signal);
          for (const remote of response.tools) {
            if (tools.length >= 200)
              throw Error("MCP server exceeds 200 tools");
            const validate = ajv.compile(remote.inputSchema);
            tools.push({
              name: `mcp_${server}_${remote.name}`,
              deferred: true,
              description: remote.description ?? remote.name,
              parameters: remote.inputSchema,
              schema: z
                .record(z.string(), z.unknown())
                .superRefine((value, ref) => {
                  if (!validate(value))
                    ref.addIssue({
                      code: "custom",
                      message: ajv.errorsText(validate.errors),
                    });
                }),
              async execute(args, context) {
                current(state, client, context.signal);
                if (state.operation)
                  throw Error("MCP connection operation in progress");
                state.active++;
                try {
                  if (
                    !(await context.approve(
                      `Call MCP tool ${server}/${remote.name}`,
                    ))
                  )
                    throw Error("Permission denied");
                  current(state, client, context.signal);
                  const result = await client.callTool(
                    { name: remote.name, arguments: args },
                    undefined,
                    {
                      signal: AbortSignal.any([
                        context.signal,
                        lifecycle.signal,
                      ]),
                      timeout: 60000,
                    },
                  );
                  current(state, client, context.signal);
                  return {
                    text: (Array.isArray(result.content) ? result.content : [])
                      .filter((c: any) => c.type === "text")
                      .map((c: any) => String(c.text))
                      .join("\n")
                      .slice(0, 60000),
                    data: result.structuredContent,
                    isError: result.isError === true,
                  };
                } finally {
                  state.active--;
                }
              },
            });
          }
          cursor = response.nextCursor;
          if (cursor) {
            if (cursors.has(cursor) || cursors.size >= 200)
              throw Error("Invalid or excessive MCP discovery pages");
            cursors.add(cursor);
          }
        } while (cursor);
        return tools;
      };
      const manage = async (
        server: string,
        action: z.infer<typeof actionSchema>,
        signal: AbortSignal,
        approve: (reason: string) => Promise<boolean>,
      ) => {
        lifecycle.signal.throwIfAborted();
        signal.throwIfAborted();
        const config = servers[server],
          state = states.get(server);
        if (!config || !state) throw Error("Unknown MCP server");
        if (state.operation)
          throw Error("MCP connection operation already in progress");
        if (state.active)
          throw Error(
            "Finish active MCP tool calls before managing this server",
          );
        if (action === "connect" && state.client)
          return `${server} already connected`;
        if (action === "refresh" && !state.client)
          throw Error("Connect the MCP server before refreshing tools");
        state.operation = action;
        let opened: Client | undefined;
        try {
          if (
            !(await approve(
              `${action} MCP ${server}: ${"command" in config ? config.command : config.url}. MCP servers may access external systems.`,
            ))
          )
            throw Error("Permission denied");
          const operationSignal = AbortSignal.any([
            signal,
            lifecycle.signal,
            AbortSignal.timeout(15000),
          ]);
          operationSignal.throwIfAborted();
          if (action === "disconnect" || action === "reconnect")
            await stop(state);
          if (action === "disconnect") {
            state.error = undefined;
            return `Disconnected ${server}`;
          }
          operationSignal.throwIfAborted();
          if (!state.client) {
            const client = new Client({ name: "hikaro", version: "0.1.0" });
            opened = client;
            state.client = client;
            // SDK initialization can call close itself. Track that same close so
            // shutdown also waits for stdio termination instead of a second no-op.
            const close = client.close.bind(client);
            let pending: Promise<void> | undefined;
            client.close = () => {
              if (!pending) {
                pending = Promise.resolve().then(close);
                closing.add(pending);
                void pending
                  .finally(() => closing.delete(pending!))
                  .catch(() => {});
              }
              return pending;
            };
            client.onclose = () => {
              if (state.client !== client) return;
              state.client = undefined;
              state.error = "Connection closed";
              unregister(state);
            };
            client.onerror = (error) => {
              if (state.client === client)
                state.error = error.message.slice(0, 500);
            };
            const transport =
              "command" in config
                ? new StdioClientTransport({
                    command: config.command,
                    args: config.args,
                    env: config.env,
                    stderr: "pipe",
                  })
                : new StreamableHTTPClientTransport(new URL(config.url));
            // Drain stderr without retaining unbounded server output.
            if (transport instanceof StdioClientTransport)
              transport.stderr?.on("data", () => {});
            await client.connect(transport, {
              signal: operationSignal,
              timeout: 15000,
            });
          }
          const client = state.client;
          if (!client) throw Error("MCP connection closed during discovery");
          const tools = await discover(server, state, client, operationSignal);
          current(state, client, operationSignal);
          const previous = state.tools;
          for (const tool of tools)
            tool.deferred =
              previous.find((old) => old.name === tool.name)?.deferred ?? true;
          // Registry batches validate before mutation. No await splits replacement
          // and rollback, so failed refreshes keep the previously working tools.
          unregister(state);
          try {
            host.registerTools(tools);
          } catch (error) {
            host.registerTools(previous);
            state.tools = previous;
            throw error;
          }
          state.tools = tools;
          state.error = undefined;
          return `Connected ${server}; ${tools.length} tools available; use tool_search to discover their schemas`;
        } catch (error) {
          state.error = (
            error instanceof Error ? error.message : String(error)
          ).slice(0, 500);
          if (opened) {
            if (state.client === opened) await stop(state);
            else await opened.close();
          }
          throw error;
        } finally {
          state.operation = undefined;
        }
      };
      host.registerTool({
        name: "mcp_connect",
        description: `Manage an explicitly configured MCP server: connect, disconnect, reconnect, or refresh tools. Available: ${Object.keys(servers).join(", ") || "none"}. Each operation requires approval.`,
        schema: z.object({
          server: z.string(),
          action: actionSchema.default("connect"),
        }),
        async execute({ server, action = "connect" }, context) {
          return {
            text: await manage(server, action, context.signal, context.approve),
          };
        },
      });
      host.registerView("mcp-status", async () => status());
      host.registerCommand("mcp", async (args, context) => {
        const [action = "status", server, ...extra] = args
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (action === "status" && !server) return status();
        if (!server || extra.length)
          throw Error(
            "Use /mcp [status|connect|disconnect|reconnect|refresh SERVER]",
          );
        await context.checkpoint();
        // This entry is an explicit user command through the trusted plugin UI.
        return manage(
          server,
          actionSchema.parse(action),
          context.signal,
          async () => true,
        );
      });
      return async () => {
        lifecycle.abort(Error("MCP plugin closed"));
        await Promise.allSettled([...states.values()].map(stop));
        await Promise.allSettled([...closing]);
      };
    },
  };
}
