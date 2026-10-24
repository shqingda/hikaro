import { expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
it("aggregates only persisted descendants and makes their edits read-only after restart", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-review-tree-")),
  );
  const cwd = join(home, "work");
  await mkdir(cwd);
  const open = () =>
    Runtime.open({ home, cwd, demo: true, approve: async () => true });
  let runtime = await open();
  try {
    const root = await runtime.session(),
      child = await runtime.store.createSession(cwd, "child", root.id),
      other = await runtime.session();
    await runtime.store.saveChildTask({
      id: child.id,
      parentId: root.id,
      task: "child",
      state: "completed",
      output: "done",
    });
    await runtime.changes.update(
      child.id,
      join(cwd, "child.txt"),
      new AbortController().signal,
      () => "child",
      undefined,
      "child-run",
    );
    await runtime.changes.update(
      other.id,
      join(cwd, "other.txt"),
      new AbortController().signal,
      () => "other",
    );
    await runtime.close();
    runtime = await open();
    const page = await runtime.review.list(root.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sessionId: child.id,
      depth: 1,
      source: "file",
      runId: "child-run",
      readOnly: true,
    });
    const row = page.items[0]!;
    expect(await runtime.review.detail(root.id, row)).toMatchObject({
      after: "child",
    });
    await expect(runtime.review.detail(other.id, row)).rejects.toThrow(
      /not found/,
    );
    expect(await runtime.changes.list(root.id)).toEqual([]);
    await runtime.review.observations.capture(
      root.id,
      cwd,
      { source: "plugin", callId: "wrapper" },
      () =>
        runtime.changes.update(
          root.id,
          join(cwd, "wrapped.txt"),
          new AbortController().signal,
          () => "wrapped",
          undefined,
          undefined,
          { callId: "nested", parentCallId: "wrapper" },
        ),
    );
    const combined = await runtime.review.list(root.id);
    expect(combined.items).toHaveLength(2);
    expect(combined.items.every((row) => row.source === "file")).toBe(true);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("opens descendant observations in the attached reviewer without offering rollback", async () => {
  const { AttachedWorkflows } =
    await import("../apps/cli/src/attached-workflows.ts");
  const { vi } = await import("vitest");
  const row = {
    id: "change",
    path: "/tmp/a",
    before: "a",
    after: null,
    timestamp: 1,
    state: "observed",
    source: "shell",
    sessionId: "child",
    depth: 1,
    readOnly: true,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "changes.review.list")
      return { items: [row], warnings: [], more: false };
    if (method === "changes.review.diff")
      return { entry: row, data: "-removed", nextOffset: null };
    throw Error(`Unexpected request ${method}`);
  });
  const choose = vi
    .fn()
    .mockResolvedValueOnce({ value: "change" })
    .mockResolvedValueOnce({ value: "close" });
  const readDocument = vi.fn().mockResolvedValue({ value: "back" });
  const error = vi.fn();
  const workflows = new AttachedWorkflows(
    {
      state: { canAct: true, session: { id: "root" } },
      supports: () => true,
      request,
    } as never,
    {
      openModelPanel: () => ({
        panel: { choose, readDocument },
        signal: new AbortController().signal,
        close() {},
      }),
      setError: error,
      closeModelPanel() {},
    } as never,
    "/tmp",
  );
  try {
    await workflows.command("/changes", "");
    expect(error).not.toHaveBeenCalled();
    expect(readDocument).toHaveBeenCalledWith(
      expect.any(String),
      "-removed",
      [],
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "changes.review.list",
      "changes.review.diff",
      "changes.review.list",
    ]);
  } finally {
    workflows.close();
  }
});
