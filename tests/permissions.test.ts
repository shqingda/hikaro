import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/runtime/src/index.ts";
import {
  canAutoApprove,
  loadPermissionMode,
  savePermissionMode,
} from "../packages/runtime/src/permissions.ts";
import { HikaroView } from "../packages/tui/src/index.ts";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import type {
  AgentEvent,
  PermissionRequest,
} from "../packages/core/src/types.ts";

const runtimes: Runtime[] = [];
const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const path of folders.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-permissions-"));
  folders.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  return { home, cwd };
}
function request(
  tool: string,
  args: Record<string, unknown>,
): PermissionRequest {
  return {
    id: "test",
    sessionId: "test",
    tool,
    arguments: args,
    reason: "tool access",
  };
}

describe("permissions", () => {
  it("applies workspace and full access to an already-created agent", async () => {
    const { home, cwd } = await fixture();
    const approve = vi.fn(async () => false);
    const runtime = await Runtime.open({
      home,
      cwd,
      demo: true,
      permissionMode: "ask",
      approve,
    });
    runtimes.push(runtime);
    const agent = await runtime.agent(await runtime.session());
    const signal = new AbortController().signal;
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: "inside.txt", content: "inside" },
          signal,
        )
      ).isError,
    ).not.toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: "../outside.txt", content: "outside" },
          signal,
        )
      ).isError,
    ).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    await runtime.setPermissionMode("full");
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: "../outside.txt", content: "outside" },
          signal,
        )
      ).isError,
    ).not.toBe(true);
    expect(await readFile(join(home, "outside.txt"), "utf8")).toBe("outside");
    expect(approve).toHaveBeenCalledTimes(1);
    const work = agent.prompt("busy");
    await expect(runtime.setPermissionMode("ask")).rejects.toThrow(
      "Finish or cancel",
    );
    await work;
    await runtime.setPermissionMode("ask");
    expect(
      (await agent.invoke("read_file", { path: "../outside.txt" }, signal))
        .isError,
    ).toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it("auto approves known workspace actions and asks about sensitive or unknown actions", async () => {
    const { home, cwd } = await fixture();
    const approve = vi.fn(async () => false);
    const runtime = await Runtime.open({
      home,
      cwd,
      demo: true,
      permissionMode: "auto",
      approve,
    });
    runtimes.push(runtime);
    const agent = await runtime.agent(await runtime.session());
    const signal = new AbortController().signal;
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: "source.ts", content: "export {};" },
          signal,
        )
      ).isError,
    ).not.toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(
      (
        await agent.invoke(
          "write_file",
          { path: ".env", content: "private" },
          signal,
        )
      ).isError,
    ).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    await writeFile(join(cwd, ".env"), "private");
    expect(
      (await agent.invoke("read_file", { path: ".env" }, signal)).isError,
    ).toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(
      (await agent.invoke("read_file", { path: "source.ts" }, signal)).isError,
    ).not.toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
    await writeFile(join(home, "outside.txt"), "outside");
    await symlink(join(home, "outside.txt"), join(cwd, "link.txt"));
    expect(
      await canAutoApprove(request("read_file", { path: "link.txt" }), cwd),
    ).toBe(false);
    expect(
      await canAutoApprove(request("shell", { command: "pwd" }), cwd),
    ).toBe(true);
    for (const command of [
      "rm -rf .",
      "pwd; rm -rf .",
      "rg --pre node pattern",
      "cat .env",
    ])
      expect(await canAutoApprove(request("shell", { command }), cwd)).toBe(
        false,
      );
    expect(
      await canAutoApprove(
        request("shell", { command: "pwd", unrestricted: true }),
        cwd,
      ),
    ).toBe(false);
    expect(await canAutoApprove(request("mcp_custom_read", {}), cwd)).toBe(
      false,
    );
  });

  it("persists the selected mode per workspace without accepting invalid settings", async () => {
    const { home, cwd } = await fixture();
    const other = join(home, "other");
    await mkdir(other);
    expect(await loadPermissionMode(home, cwd)).toBe("ask");
    await savePermissionMode(home, cwd, "full");
    expect(await loadPermissionMode(home, cwd)).toBe("full");
    expect(await loadPermissionMode(home, other)).toBe("ask");
    await savePermissionMode(home, other, "auto");
    expect(await loadPermissionMode(home, cwd)).toBe("full");
    expect(await loadPermissionMode(home, other)).toBe("auto");
    await writeFile(join(home, "permissions.json"), '{"bad":"read-only"}');
    await expect(loadPermissionMode(home, cwd)).rejects.toThrow();
  });
});

it("activity indicator animates runs, pauses for approval, and stops on cancellation and disposal", async () => {
  vi.useFakeTimers();
  const tui = new TuiAltScreen({
    rows: 24,
    columns: 80,
    write: () => {},
  } as Terminal);
  const render = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const view = new HikaroView(tui, {
    cwd: "/tmp",
    model: "test",
    onPrompt: async () => {},
    onCommand: async () => {},
    onExit: () => {},
  });
  const event = (type: string, data: Record<string, unknown> = {}) =>
    view.event({
      type,
      data,
      sessionId: "test",
      seq: 1,
      timestamp: 1,
    } as AgentEvent);
  try {
    expect(vi.getTimerCount()).toBe(0);
    event("run.start");
    const first = view.editor.render(80)[0];
    expect(first).toContain("Working");
    vi.advanceTimersByTime(80);
    expect(view.editor.render(80)[0]).not.toBe(first);
    event("thinking.delta", { text: "hidden reasoning" });
    expect(view.editor.render(80)[0]).toContain("Thinking");
    event("tool.start", { name: "shell" });
    expect(view.editor.render(80)[0]).toContain("Running shell");
    const abort = new AbortController();
    const approval = view.approve(request("shell", {}), abort.signal);
    expect(view.editor.render(80)[0]).toContain("Approval required");
    expect(vi.getTimerCount()).toBe(0);
    abort.abort();
    expect(await approval).toBe(false);
    event("run.end", { status: "cancelled" });
    expect(view.editor.render(80)[0]).not.toContain("Running");
    expect(vi.getTimerCount()).toBe(0);
    render.mockClear();
    vi.advanceTimersByTime(800);
    expect(render).not.toHaveBeenCalled();
    event("run.start", { operation: "compact" });
    expect(view.editor.render(80)[0]).toContain("Compacting");
    view.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.dispose();
  }
});
