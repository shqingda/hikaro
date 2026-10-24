import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../packages/runtime/src/index.ts";
import { executionItems } from "../packages/runtime/src/execution-items.ts";
import type { ToolContext } from "../packages/core/src/types.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";

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
  let otherSessionId = "";
  let exitedId = "";
  const processNote = "Observed descendant PID 424242 remains running.";
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
      expect(row).toMatchObject({
        id: exitedId,
        state: "exited",
        exitCode: 0,
        processNote: expect.any(String),
      });
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
    await runtime.store.saveTerminalRecord({
      id: "00000000-0000-4000-8000-000000000003",
      owner: sessionId,
      command: "detached child",
      state: "descendants_running",
      exitCode: 0,
      output: "",
      processNote,
    });
    otherSessionId = (await runtime.store.createSession(home)).id;
    await runtime.store.saveTerminalRecord({
      id: "00000000-0000-4000-8000-000000000004",
      owner: otherSessionId,
      command: "other session command",
      state: "descendants_running",
      output: "",
      processNote: "Other session observation",
    });
  } finally {
    await runtime.close();
  }
  runtime = await open();
  try {
    expect(runtime.terminalList(sessionId)).toEqual([]);
    await runtime.loadTerminals(sessionId);
    await runtime.loadTerminals(otherSessionId);
    const items = executionItems(
      { pendingPrompts: () => [], pendingSteering: () => [] },
      runtime,
      sessionId,
      "terminals",
    );
    expect(items.map((item) => [item.title, item.state])).toEqual([
      ["printf 'DONE-OUTPUT\\n'", "exited · exit 0"],
      ["sleep 600", "unknown after host restart"],
      ["detached child", "unknown after host restart · exit 0"],
    ]);
    expect(items[0]!.detail).toContain("DONE-OUTPUT");
    expect(items[1]!.detail).toContain("not stopped or verified");
    expect(items[2]!.detail).toContain(
      `Historical observation: ${processNote}`,
    );
    expect(items[2]!.detail).not.toContain("Other session observation");
    expect(items.every((item) => item.actions.length === 0)).toBe(true);
    expect(runtime.terminalList(otherSessionId)).toHaveLength(1);
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

it("migrates old terminal records and bounds observation summaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-terminal-migration-"));
  const path = join(home, "sessions.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec(`
    CREATE TABLE terminal_records(id TEXT PRIMARY KEY,owner TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,exitCode INTEGER,output TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
    INSERT INTO terminal_records VALUES('legacy','owner','command','running',NULL,'',1,1);
  `);
  seed.close();
  const store = await SQLiteStore.open(path);
  try {
    const [legacy] = await store.terminalRecords("owner");
    expect(legacy).toMatchObject({ id: "legacy", state: "running" });
    expect(legacy?.processNote).toBeUndefined();
    await store.saveTerminalRecord({
      id: "legacy",
      owner: "owner",
      command: "command",
      state: "descendants_running",
      output: "",
      processNote: "x".repeat(5000),
    });
    expect((await store.terminalRecords("owner"))[0]?.processNote).toBe(
      "x".repeat(4096),
    );
    expect(await store.terminalRecords("other-owner")).toEqual([]);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
