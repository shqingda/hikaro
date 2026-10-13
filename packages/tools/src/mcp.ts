import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv } from "ajv";
import type { Plugin } from "../../core/src/types.ts";
const Server = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ url: z.url() }),
]);
export const MCPConfig = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), Server);
export function mcpPlugin(servers: z.infer<typeof MCPConfig>): Plugin {
  return {
    id: "hikaro.mcp",
    apiVersion: 1,
    setup(host) {
      const clients = new Map<string, Client>();
      const connecting = new Set<string>();
      host.registerTool({
        name: "mcp_connect",
        description: `Connect an explicitly configured MCP server and discover its tools. Available: ${Object.keys(servers).join(", ") || "none"}. Each connection requires approval.`,
        schema: z.object({ server: z.string() }),
        async execute({ server }, ctx) {
          const config = servers[server];
          if (!config) throw Error("Unknown MCP server");
          if (clients.has(server))
            return { text: `${server} already connected` };
          if (connecting.has(server))
            throw Error("Connection already in progress");
          if (
            !(await ctx.approve(
              `Connect MCP ${server}: ${"command" in config ? config.command : config.url}. MCP servers may access external systems.`,
            ))
          )
            throw Error("Permission denied");
          connecting.add(server);
          const client = new Client({ name: "hikaro", version: "0.1.0" });
          try {
            const transport =
              "command" in config
                ? new StdioClientTransport({
                    command: config.command,
                    args: config.args,
                    env: config.env,
                    stderr: "pipe",
                  })
                : new StreamableHTTPClientTransport(new URL(config.url));
            await client.connect(transport);
            const ajv = new Ajv({ strict: false });
            let cursor: string | undefined;
            let count = 0;
            do {
              const response = await client.listTools(
                cursor ? { cursor } : undefined,
                { signal: ctx.signal, timeout: 15000 },
              );
              for (const remote of response.tools) {
                if (++count > 200) throw Error("MCP server exceeds 200 tools");
                const validate = ajv.compile(remote.inputSchema);
                host.registerTool({
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
                    if (
                      !(await context.approve(
                        `Call MCP tool ${server}/${remote.name}`,
                      ))
                    )
                      throw Error("Permission denied");
                    const result = await client.callTool(
                      { name: remote.name, arguments: args },
                      undefined,
                      { signal: context.signal, timeout: 60000 },
                    );
                    return {
                      text: (Array.isArray(result.content)
                        ? result.content
                        : []
                      )
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => String(c.text))
                        .join("\n")
                        .slice(0, 60000),
                      data: result.structuredContent,
                      isError: result.isError === true,
                    };
                  },
                });
              }
              cursor = response.nextCursor;
            } while (cursor);
            clients.set(server, client);
            return {
              text: `Connected ${server}; ${count} tools available; use tool_search to discover their schemas`,
            };
          } catch (e) {
            await client.close();
            throw e;
          } finally {
            connecting.delete(server);
          }
        },
      });
      return async () => {
        await Promise.allSettled([...clients.values()].map((c) => c.close()));
      };
    },
  };
}
