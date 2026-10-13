import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpPlugin } from "../packages/tools/src/mcp.ts";
import { Agent, PluginHost, ToolRegistry } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
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
