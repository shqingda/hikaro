import { afterEach, expect, it, vi } from "vitest";
import {
  PluginHost,
  ToolRegistry,
  type ToolContext,
} from "../packages/core/src/index.ts";
import { terminalPlugin } from "../packages/tools/src/terminal.ts";

afterEach(() => {
  vi.doUnmock("node-pty");
  vi.resetModules();
});
it("does not start a terminal cancelled while its native module loads", async () => {
  let loaded!: () => void;
  let release!: () => void;
  const importing = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spawn = vi.fn(() => ({ onData() {}, onExit() {}, kill() {} }));
  vi.doMock("node-pty", async () => {
    loaded();
    await paused;
    return { spawn };
  });
  const tools = new ToolRegistry();
  const host = new PluginHost(tools);
  await host.load(terminalPlugin(true));
  const controller = new AbortController();
  const ctx: ToolContext = {
    cwd: process.cwd(),
    sessionId: "terminal",
    signal: controller.signal,
    callId: "start",
    depth: 0,
    budget: {
      usage: { input: 0, output: 0, cost: 0 },
      maxCost: 1,
      modelCallsLeft: 1,
    },
    approve: async () => true,
    invoke: async () => ({ text: "" }),
    emit: async () => {},
  };
  const work = tools
    .get("terminal_start")!
    .execute({ command: "true", unrestricted: false, cols: 80, rows: 24 }, ctx);
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  try {
    await importing;
    controller.abort();
    release();
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    release();
    await host.close();
  }
});
