import { it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpPlugin } from "../packages/tools/src/mcp.ts";
import { Agent, PluginHost, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("leaves no MCP tools after failed discovery and permits a clean retry", async () => {
  const echo = { name: "echo", inputSchema: { type: "object" as const } };
  vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, "listTools")
    .mockResolvedValueOnce({ tools: [echo], nextCursor: "next" })
    .mockRejectedValueOnce(Error("Discovery failed"))
    .mockResolvedValueOnce({ tools: [echo] });
  const close = vi
    .spyOn(Client.prototype, "close")
    .mockResolvedValue(undefined);
  const store = await SQLiteStore.open(":memory:");
  const tools = new ToolRegistry();
  const host = new PluginHost(tools);
  try {
    await host.load(mcpPlugin({ fixture: { url: "http://localhost/mcp" } }));
    const agent = new Agent({
      session: await store.createSession("/tmp"),
      store,
      tools,
      approve: async () => true,
      provider: {
        id: "unused",
        model: "unused",
        contextWindow: 8000,
        async *stream() {
          throw Error("No model calls expected");
        },
      },
    });
    const failed = await agent.invoke(
      "mcp_connect",
      { server: "fixture" },
      new AbortController().signal,
    );
    expect(failed.isError).toBe(true);
    expect(tools.names()).toEqual(new Set(["mcp_connect"]));
    expect(close).toHaveBeenCalledOnce();
    const retried = await agent.invoke(
      "mcp_connect",
      { server: "fixture" },
      new AbortController().signal,
    );
    expect(retried.isError).not.toBe(true);
    expect(tools.names()).toEqual(new Set(["mcp_connect", "mcp_fixture_echo"]));
  } finally {
    await host.close();
    await store.close();
    vi.restoreAllMocks();
  }
});

it("discovers MCP tools lazily and preserves structured content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hikaro-mcp-"));
  const server = join(dir, "server.mjs");
  await writeFile(
    server,
    `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value']}}]};if(m.method==='tools/call')result={content:[{type:'text',text:String(m.params.arguments.value)}],structuredContent:{value:m.params.arguments.value},isError:false};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
  );
  const store = await SQLiteStore.open(":memory:");
  const tools = new ToolRegistry(),
    host = new PluginHost(tools);
  try {
    await host.load(
      mcpPlugin({ fixture: { command: process.execPath, args: [server] } }),
    );
    const agent = new Agent({
      session: await store.createSession(dir),
      store,
      tools,
      approve: async () => true,
      provider: {
        id: "unused",
        model: "unused",
        contextWindow: 8000,
        async *stream() {
          throw Error("No model calls expected");
        },
      },
    });
    const connect = await agent.invoke(
      "mcp_connect",
      { server: "fixture" },
      AbortSignal.timeout(5000),
    );
    expect(connect.isError).not.toBe(true);
    expect(tools.definitions().some((t) => t.name === "mcp_fixture_echo")).toBe(
      false,
    );
    expect(
      tools.search("echo").some((t) => t.name === "mcp_fixture_echo"),
    ).toBe(true);
    const result = await agent.invoke(
      "mcp_fixture_echo",
      { value: 7 },
      AbortSignal.timeout(5000),
    );
    expect(result.text).toBe("7");
    expect(result.data).toEqual({ value: 7 });
    expect(
      (
        await agent.invoke(
          "mcp_fixture_echo",
          { value: "wrong" },
          AbortSignal.timeout(5000),
        )
      ).isError,
    ).toBe(true);
  } finally {
    await host.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
