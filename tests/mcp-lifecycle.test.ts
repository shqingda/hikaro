import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as z from "zod";
import { PluginHost, ToolRegistry } from "../packages/core/src/index.ts";
import type {
  PluginHost as PluginAPI,
  ToolContext,
} from "../packages/core/src/types.ts";
import { mcpPlugin } from "../packages/tools/src/mcp.ts";

const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});
const remote = (name: string) => ({
  name,
  inputSchema: { type: "object" as const },
});
const context = () =>
  ({
    approve: vi.fn(async () => true),
    signal: AbortSignal.timeout(5000),
  }) as unknown as ToolContext;
async function fixture() {
  const clients: Client[] = [];
  vi.spyOn(Client.prototype, "connect").mockImplementation(async function (
    this: Client,
  ) {
    clients.push(this);
  });
  const close = vi
    .spyOn(Client.prototype, "close")
    .mockResolvedValue(undefined);
  const list = vi
    .spyOn(Client.prototype, "listTools")
    .mockResolvedValue({ tools: [remote("echo")] });
  const tools = new ToolRegistry(),
    host = new PluginHost(tools);
  hosts.push(host);
  await host.load(mcpPlugin({ fixture: { url: "http://localhost/mcp" } }));
  const manage = (action = "connect", ctx = context()) =>
    tools.get("mcp_connect")!.execute({ server: "fixture", action }, ctx);
  return { clients, tools, host, close, list, manage };
}

it("unregisters only the exact tools owned by the registering plugin", async () => {
  const tools = new ToolRegistry(),
    host = new PluginHost(tools);
  hosts.push(host);
  let api!: PluginAPI;
  const tool = {
    name: "owned",
    description: "fixture",
    schema: z.object({}),
    execute: async () => ({ text: "ok" }),
  };
  await host.load({
    id: "owner",
    apiVersion: 1,
    setup(value) {
      api = value;
      value.registerTool(tool);
    },
  });
  tools.register({ ...tool, name: "foreign" });
  expect(() => api.unregisterTools(["owned", "foreign"])).toThrow(/owned/);
  expect(tools.get("owned")).toBe(tool);
  tools.remove("owned");
  const replacement = { ...tool };
  tools.register(replacement);
  api.unregisterTools(["owned"]);
  expect(tools.get("owned")).toBe(replacement);
  expect(tools.get("foreign")).toBeDefined();
});

it("refreshes atomically, preserves tools on failure, and exposes explicit management without a model", async () => {
  const f = await fixture();
  const ctx = context();
  await f.manage("connect", ctx);
  const original = f.tools.get("mcp_fixture_echo")!;
  await expect(
    f.manage("reconnect", { ...ctx, approve: async () => false }),
  ).rejects.toThrow("Permission denied");
  expect(f.tools.get(original.name)).toBe(original);
  expect(f.close).not.toHaveBeenCalled();
  f.tools.register({ ...original, name: "mcp_fixture_conflict" });
  f.list.mockResolvedValueOnce({ tools: [remote("conflict")] });
  await expect(f.manage("refresh")).rejects.toThrow(/Duplicate tool/);
  expect(f.tools.get(original.name)).toBe(original);
  f.list.mockResolvedValueOnce({ tools: [remote("next")] });
  await f.manage("refresh");
  expect(f.tools.get(original.name)).toBeUndefined();
  expect(f.tools.get("mcp_fixture_next")).toBeDefined();
  const command = f.host.commands.get("mcp")!;
  const commandContext = {
    signal: ctx.signal,
    checkpoint: async () => {},
  } as any;
  expect(await command("status", commandContext)).toContain(
    "connected · 1 tool",
  );
  await command("disconnect fixture", commandContext);
  expect(f.tools.get("mcp_fixture_next")).toBeUndefined();
  expect(await command("status", commandContext)).toContain("disconnected");
  await f.manage("reconnect", ctx);
  expect(ctx.approve).toHaveBeenCalledTimes(2);
  await expect(original.execute({}, ctx)).rejects.toThrow(/disconnected|stale/);
  f.clients.at(-1)!.onclose?.();
  expect(f.tools.get(original.name)).toBeUndefined();
  expect(await command("status", commandContext)).toContain("disconnected");
});

it("refuses management during active tool calls and competing connection operations", async () => {
  const f = await fixture();
  let finish!: (value: any) => void;
  vi.spyOn(Client.prototype, "callTool").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await f.manage();
  const call = f.tools.get("mcp_fixture_echo")!.execute({}, context());
  await vi.waitFor(() =>
    expect(Client.prototype.callTool).toHaveBeenCalledOnce(),
  );
  for (const action of ["disconnect", "reconnect", "refresh"])
    await expect(f.manage(action)).rejects.toThrow(/active/);
  finish({ content: [] });
  await call;
  let discovered!: (value: any) => void;
  f.list.mockReturnValueOnce(
    new Promise((resolve) => {
      discovered = resolve;
    }),
  );
  const refresh = f.manage("refresh");
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
  await expect(f.manage("disconnect")).rejects.toThrow(/progress/);
  discovered({ tools: [remote("fresh")] });
  await refresh;
});

it("closes pending discovery and prevents late publication after shutdown", async () => {
  const f = await fixture();
  let discovered!: (value: any) => void;
  f.list.mockReturnValueOnce(
    new Promise((resolve) => {
      discovered = resolve;
    }),
  );
  const connecting = f.manage();
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
  await f.host.close();
  discovered({ tools: [remote("late")] });
  await expect(connecting).rejects.toThrow();
  expect(f.tools.get("mcp_fixture_late")).toBeUndefined();
  expect(f.close).toHaveBeenCalledOnce();
});
