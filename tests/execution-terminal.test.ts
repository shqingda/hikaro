import { expect, it, vi } from "vitest";
import {
  PluginHost,
  ToolRegistry,
  type ToolContext,
} from "../packages/core/src/index.ts";
import {
  TerminalManager,
  terminalPlugin,
} from "../packages/tools/src/terminal.ts";
it("keeps a non-consuming output preview, isolates ownership, and confirms actual terminal exit", async () => {
  const manager = new TerminalManager();
  const tools = new ToolRegistry();
  const host = new PluginHost(tools);
  await host.load(terminalPlugin(true, () => true, manager));
  const ctx = {
    cwd: process.cwd(),
    sessionId: "owner",
    signal: new AbortController().signal,
    approve: async () => true,
  } as unknown as ToolContext;
  try {
    const result = await tools
      .get("terminal_start")!
      .execute(
        {
          command:
            "printf 'READY\\n'; read answer; printf 'ANSWER:%s\\n' \"$answer\"; sleep 30",
          cols: 80,
          rows: 24,
        },
        ctx,
      );
    const id = (result.data as { id: string }).id;
    await vi.waitFor(() =>
      expect(manager.detail("owner", id).output).toContain("READY"),
    );
    expect(manager.list("other")).toEqual([]);
    expect(() => manager.stop("other", id)).toThrow(/not found/);
    await tools.get("terminal_read")!.execute({ id }, ctx);
    expect(manager.detail("owner", id).output).toContain("READY");
    manager.send("owner", id, "yes\n");
    await vi.waitFor(() =>
      expect(manager.detail("owner", id).output).toContain("ANSWER:yes"),
    );
    manager.stop("owner", id);
    expect(["stopping", "exited"]).toContain(manager.detail("owner", id).state);
    await vi.waitFor(() =>
      expect(manager.detail("owner", id).state).toBe("exited"),
    );
    expect(manager.detail("owner", id).exitCode).toEqual(expect.any(Number));
    await tools.get("terminal_read")!.execute({ id }, ctx);
    expect(manager.detail("owner", id).state).toBe("exited");
  } finally {
    await host.close();
  }
});
