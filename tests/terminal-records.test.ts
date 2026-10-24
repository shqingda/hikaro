import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import { executionItems } from "../packages/runtime/src/execution-items.ts";
import type { ToolContext } from "../packages/core/src/types.ts";

it("restores background terminal outcomes after restart without offering control", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-terminal-records-"));
  const open = () =>
    Runtime.open({
      home,
      cwd: home,
      demo: true,
      approve: async () => true,
      permissionMode: "full",
    });
  let runtime = await open();
  let sessionId = "";
  let exitedId = "";
  try {
    const session = await runtime.session();
    sessionId = session.id;
    const ctx = {
      cwd: home,
      sessionId,
      signal: new AbortController().signal,
      approve: async () => true,
    } as unknown as ToolContext;
    const result = await runtime.tools
      .get("terminal_start")!
      .execute({ command: "printf 'DONE-OUTPUT\\n'", cols: 80, rows: 24 }, ctx);
    exitedId = (result.data as { id: string }).id;
    await vi.waitFor(() =>
      expect(runtime.terminals.detail(sessionId, exitedId).state).toBe(
        "exited",
      ),
    );
    await vi.waitFor(async () => {
      const [row] = await runtime.store.terminalRecords(sessionId);
      expect(row).toMatchObject({ id: exitedId, state: "exited", exitCode: 0 });
      expect(row!.output).toContain("DONE-OUTPUT");
    });
    // A terminal whose host exited before any exit was observed.
    await runtime.store.saveTerminalRecord({
      id: "00000000-0000-4000-8000-000000000002",
      owner: sessionId,
      command: "sleep 600",
      state: "running",
      output: "",
    });
  } finally {
    await runtime.close();
  }
  runtime = await open();
  try {
    expect(runtime.terminalList(sessionId)).toEqual([]);
    await runtime.loadTerminals(sessionId);
    const items = executionItems(
      { pendingPrompts: () => [], pendingSteering: () => [] },
      runtime,
      sessionId,
      "terminals",
    );
    expect(items.map((item) => [item.title, item.state])).toEqual([
      ["printf 'DONE-OUTPUT\\n'", "exited · exit 0"],
      ["sleep 600", "unknown after host restart"],
    ]);
    expect(items[0]!.detail).toContain("DONE-OUTPUT");
    expect(items[1]!.detail).toContain("not stopped or verified");
    expect(items.every((item) => item.actions.length === 0)).toBe(true);
    expect(() => runtime.terminals.stop(sessionId, exitedId)).toThrow(
      /not found/,
    );
    await runtime.store.deleteSession(sessionId);
    await runtime.loadTerminals(sessionId);
    expect(runtime.terminalList(sessionId)).toEqual([]);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
