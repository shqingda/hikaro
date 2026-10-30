import { describe, expect, it, vi } from "vitest";
import {
  attachedWorkspaceSources,
  nativeWorkspaceSources,
} from "../packages/cli/src/workbench-sources.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
import type {
  ObjectDetail,
  ObjectSource,
} from "../packages/tui/src/object-page.ts";
import type { ClientConnection } from "../packages/client-core/src/connection.ts";
import type { ExecutionStatus } from "../packages/client-core/src/index.ts";
import type { Runtime } from "../packages/runtime/src/index.ts";
import type { Agent, Session } from "../packages/core/src/index.ts";
import type { ExecutionItem } from "../packages/runtime/src/execution-items.ts";
import type { ReviewEntry } from "../packages/runtime/src/change-review.ts";

const signal = () => new AbortController().signal;
const session: Session = {
  id: "session-a",
  cwd: "/workspace",
  title: "Task",
  createdAt: 0,
};
const change: ReviewEntry = {
  id: "change-a",
  path: "/workspace/a.ts",
  before: "before",
  after: "after",
  state: "committed",
  timestamp: 1,
  sessionId: session.id,
  depth: 0,
  source: "file",
  readOnly: false,
};
const queued: ExecutionItem = {
  id: "q1",
  title: "1. Fix auth",
  state: "0 image attachments",
  detail: "Fix auth",
  editText: "Fix auth",
  actions: [
    { value: "edit", label: "Edit message" },
    { value: "remove", label: "Remove message" },
    { value: "first", label: "Move to front" },
  ],
};
function viewMock() {
  let draft = "";
  const panel = {
    choose: vi.fn(async () => ({ value: "cancel" })),
    prompt: vi.fn(async () => "Updated task"),
  };
  const close = vi.fn();
  const view = {
    options: {
      previewAttachment: undefined as
        undefined | ((path: string, signal: AbortSignal) => Promise<string>),
    },
    editor: {
      getExpandedText: () => draft,
      setText: (text: string) => {
        draft = text;
      },
    },
    notice: vi.fn(),
    command: vi.fn(async (_text: string) => {}),
    selectWorkspace: vi.fn(),
    removeDraftAttachment: vi.fn(),
    openWorkspaceObject: vi.fn(async (_tab: string, _id: string) => {}),
    openModelPanel: vi.fn(() => ({ panel, signal: signal(), close })),
  };
  return { view: view as unknown as HikaroView, panel, close, raw: view };
}
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
function remote(handlers: Record<string, Handler>, readonly = false) {
  const status = {
    canAct: true,
    connection: "connected",
    session,
    sessionRole: readonly ? "view" : "owner",
    hostInstanceId: "host-a",
    revision: 1,
  } as ExecutionStatus;
  const listeners = new Set<() => void>();
  const request = vi.fn(
    async (
      method: string,
      params: Record<string, unknown>,
      options?: { beforeSend?: () => void },
    ) => {
      options?.beforeSend?.();
      const handle = handlers[method];
      if (!handle) throw Error(`Unexpected request: ${method}`);
      return handle(params);
    },
  );
  const client = {
    get status() {
      return status;
    },
    get state() {
      return status;
    },
    supports: (method: string) => !!handlers[method],
    request,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client: client as unknown as ClientConnection,
    request,
    status,
    listeners,
    notify: () => listeners.forEach((fn) => fn()),
  };
}
async function detail(
  source: ObjectSource,
  predicate: (id: string) => boolean = () => true,
) {
  const items = await source.load(signal());
  const item = items.find((item) => predicate(item.id));
  expect(item).toBeDefined();
  return { item: item!, detail: await source.detail(item!, signal()) };
}
function action(detail: ObjectDetail, id: string) {
  const action = detail.actions?.find((action) => action.id === id);
  expect(action).toBeDefined();
  return action!;
}

describe("workbench change sources", () => {
  it("reads the original diff in parts, marks a version reviewed, and safely appends a file reference", async () => {
    const mock = viewMock();
    mock.raw.editor.setText("existing draft");
    const text = "x".repeat(15999) + "😀last part";
    const rpc = remote({
      "changes.review.list": () => ({
        items: [change],
        more: false,
        warnings: ["Observed shell changes are incomplete"],
      }),
      "changes.review.diff": (p) => ({
        entry: change,
        data: text.slice(Number(p.offset), Number(p.offset) + 16000),
        total: text.length,
        nextOffset:
          Number(p.offset) + 16000 < text.length
            ? Number(p.offset) + 16000
            : null,
      }),
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Changes;
    const first = await detail(source);
    expect(first.detail.text).toContain(
      "Observed shell changes are incomplete",
    );
    expect(first.detail.text).not.toContain("last part");
    expect(first.detail.text.endsWith("x")).toBe(true);
    await action(first.detail, "next").run();
    const second = await source.detail(first.item, signal());
    expect(second.text).toContain("last part");
    expect(second.text).toContain("😀last part");
    expect(second.text).toContain("Part 2 · final");
    await action(second, "previous").run();
    expect((await source.detail(first.item, signal())).text).toBe(
      first.detail.text,
    );
    expect(
      rpc.request.mock.calls
        .filter(([method]) => method === "changes.review.diff")
        .map(([, p]) => p.offset),
    ).toEqual([0, 15999, 0]);
    await action(second, "reviewed").run();
    expect((await source.load(signal()))[0]?.group).toContain("reviewed");
    await action(second, "reference").run();
    expect(mock.raw.editor.getExpandedText()).toBe(
      'existing draft\n\n@"/workspace/a.ts"',
    );
    expect(mock.raw.command).not.toHaveBeenCalled();
  });

  it("defaults rollback to cancel and rechecks the exact edit after confirmation", async () => {
    const mock = viewMock();
    let entry = { ...change };
    const restore = vi.fn();
    const rpc = remote({
      "changes.review.list": () => ({ items: [entry], more: false }),
      "changes.review.diff": () => ({
        entry: { ...entry },
        data: "diff",
        total: 4,
        nextOffset: null,
      }),
      "changes.rollback": restore,
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Changes;
    const selected = (await detail(source)).detail;
    await action(selected, "rollback").run();
    expect(restore).not.toHaveBeenCalled();
    const args = mock.panel.choose.mock.calls[0] as unknown as unknown[];
    expect(args[1]).toEqual([
      { value: "cancel", label: "Cancel" },
      { value: "confirm", label: "Confirm" },
    ]);
    expect(args[4]).toMatchObject({
      cancelValue: "cancel",
      requireNoticeVisible: true,
    });
    mock.panel.choose.mockImplementationOnce(async () => {
      entry = { ...entry, state: "reverted" };
      return { value: "confirm" };
    });
    await expect(action(selected, "rollback").run()).rejects.toThrow(
      "Change was updated",
    );
    expect(restore).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(2);
  });

  it("retains host authority and hides restore for descendant and view-only records", async () => {
    const mock = viewMock();
    const rpc = remote(
      {
        "changes.review.list": () => ({
          items: [{ ...change, sessionId: "child", readOnly: true }],
          more: false,
        }),
        "changes.review.diff": () => ({
          entry: { ...change, sessionId: "child", readOnly: true },
          data: "diff",
          total: 4,
          nextOffset: null,
        }),
        "changes.rollback": () => ({}),
      },
      true,
    );
    const selected = (
      await detail(
        attachedWorkspaceSources(mock.view, rpc.client, session.id).Changes,
      )
    ).detail;
    expect(selected.actions?.map((action) => action.id)).not.toContain(
      "rollback",
    );
    expect(selected.text).toContain("read-only");
  });

  it("restores only the confirmed session edit and offers redo for reverted records", async () => {
    const mock = viewMock();
    let entry = { ...change };
    const rpc = remote({
      "changes.review.list": () => ({ items: [entry], more: false }),
      "changes.review.diff": () => ({
        entry: { ...entry },
        data: "diff",
        total: 4,
        nextOffset: null,
      }),
      "changes.rollback": (p) => {
        expect(p.sessionId).toBe(session.id);
        expect(p.id).toBe(change.id);
        entry = { ...entry, state: "reverted" };
        return { completed: true };
      },
      "changes.redo": (p) => {
        expect(p.sessionId).toBe(session.id);
        expect(p.id).toBe(change.id);
        return { completed: true };
      },
    });
    mock.panel.choose.mockResolvedValue({ value: "confirm" });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Changes;
    await action((await detail(source)).detail, "rollback").run();
    const reverted = (await detail(source)).detail;
    expect(reverted.actions?.some((action) => action.id === "rollback")).toBe(
      false,
    );
    await action(reverted, "redo").run();
    expect(
      rpc.request.mock.calls.filter(([method]) =>
        ["changes.rollback", "changes.redo"].includes(method),
      ),
    ).toHaveLength(2);
  });

  it("revalidates batch membership and stops at the first rollback conflict", async () => {
    const mock = viewMock();
    const older = {
      ...change,
      id: "older",
      path: "/workspace/older.ts",
      timestamp: 1,
      runId: "run-a",
    };
    const newer = { ...change, id: "newer", timestamp: 2, runId: "run-a" };
    let entries = [newer, older];
    const restored: string[] = [];
    const rpc = remote({
      "changes.review.list": () => ({ items: entries, more: false }),
      "changes.review.diff": (p) => ({
        entry: entries.find((entry) => entry.id === p.id),
        data: "diff",
        total: 4,
        nextOffset: null,
      }),
      "changes.rollback": (p) => {
        restored.push(String(p.id));
        if (p.id === older.id) throw Error("file changed externally");
        return { completed: true };
      },
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Changes;
    const selected = (await detail(source, (id) => id.includes("older")))
      .detail;
    await action(selected, "batch").run();
    expect(restored).toEqual([]);
    mock.panel.choose.mockImplementationOnce(async () => {
      entries = [{ ...newer, id: "unreviewed", timestamp: 3 }, ...entries];
      return { value: "confirm" };
    });
    await expect(action(selected, "batch").run()).rejects.toThrow("updated");
    expect(restored).toEqual([]);
    entries = [newer, older];
    mock.panel.choose.mockResolvedValueOnce({ value: "confirm" });
    await expect(action(selected, "batch").run()).rejects.toThrow(
      "Rolled back 1/2 changes",
    );
    expect(restored).toEqual(["newer", "older"]);
  });
});

describe("workbench Activity sources", () => {
  it("confirms terminal input and sends exactly one line terminator without a queue hold", async () => {
    const mock = viewMock();
    const terminal = {
      ...queued,
      id: "terminal",
      title: "read answer",
      editText: undefined,
      state: "running",
      actions: [{ value: "send", label: "Send a line…" }],
    };
    const mutate = vi.fn();
    const rpc = remote({
      "execution.read": (p) =>
        p.id ? terminal : p.kind === "terminals" ? [terminal] : [],
      "execution.action": mutate,
    });
    mock.panel.prompt.mockResolvedValue("hello");
    const selected = (
      await detail(
        attachedWorkspaceSources(mock.view, rpc.client, session.id).Activity,
      )
    ).detail;
    await action(selected, "send").run();
    expect(mutate).not.toHaveBeenCalled();
    mock.panel.choose.mockResolvedValueOnce({ value: "confirm" });
    await action(selected, "send").run();
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminals",
        action: "send",
        text: "hello\n",
      }),
    );
    expect(
      rpc.request.mock.calls.some(([method]) => method === "execution.hold"),
    ).toBe(false);
  });
  it("permits normal streamed event revisions during reads and confirmation", async () => {
    const mock = viewMock();
    const mutate = vi.fn();
    const rpc = remote({
      "execution.read": (p) => {
        rpc.status.revision++;
        rpc.notify();
        return p.id ? queued : p.kind === "queue" ? [queued] : [];
      },
      "execution.hold": () => ({ token: "token" }),
      "execution.release": () => ({}),
      "execution.action": mutate,
    });
    const selected = (
      await detail(
        attachedWorkspaceSources(mock.view, rpc.client, session.id).Activity,
      )
    ).detail;
    mock.panel.choose.mockImplementationOnce(async () => {
      rpc.status.revision++;
      rpc.notify();
      return { value: "confirm" };
    });
    await action(selected, "remove").run();
    expect(mutate).toHaveBeenCalledOnce();
    expect(rpc.listeners.size).toBe(0);
  });
  it("reads without pausing, then briefly holds and revalidates around a queue mutation", async () => {
    const mock = viewMock();
    const calls: string[] = [];
    let item = { ...queued };
    const rpc = remote({
      "execution.read": (p) => {
        calls.push(`read:${p.kind}${p.id ? ":detail" : ""}`);
        return p.id ? { ...item } : p.kind === "queue" ? [item] : [];
      },
      "execution.hold": () => {
        calls.push("hold");
        return { token: "hold-a" };
      },
      "execution.release": () => {
        calls.push("release");
        return {};
      },
      "execution.action": (p) => {
        calls.push("act");
        expect(p.token).toBe("hold-a");
        expect(p.text).toBe("Updated task");
        return {};
      },
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Activity;
    const selected = (await detail(source)).detail;
    expect(calls).not.toContain("hold");
    mock.panel.prompt.mockImplementationOnce(async () => {
      expect(calls).not.toContain("hold");
      return "Updated task";
    });
    await action(selected, "edit").run();
    expect(calls.slice(-4)).toEqual([
      "hold",
      "read:queue:detail",
      "act",
      "release",
    ]);
    item = { ...queued, editText: "Changed elsewhere" };
    await expect(action(selected, "first").run()).rejects.toThrow(
      "item changed",
    );
    expect(calls.at(-1)).toBe("release");
    expect(calls.filter((call) => call === "act")).toHaveLength(1);
  });

  it("never performs a delayed action after disconnect and reconnect to the same host", async () => {
    const mock = viewMock();
    const mutate = vi.fn();
    const rpc = remote({
      "execution.read": (p) =>
        p.id ? queued : p.kind === "queue" ? [queued] : [],
      "execution.hold": () => ({ token: "token" }),
      "execution.release": () => ({}),
      "execution.action": mutate,
    });
    const selected = (
      await detail(
        attachedWorkspaceSources(mock.view, rpc.client, session.id).Activity,
      )
    ).detail;
    mock.panel.choose.mockImplementationOnce(async () => {
      rpc.status.canAct = false;
      rpc.notify();
      rpc.status.canAct = true;
      rpc.notify();
      return { value: "confirm" };
    });
    await expect(action(selected, "remove").run()).rejects.toThrow(
      "no longer current",
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(
      rpc.request.mock.calls.some(([method]) => method === "execution.hold"),
    ).toBe(false);
    expect(rpc.listeners.size).toBe(0);
  });

  it("uses the same short hold for steering and rechecks changed ownership after confirmation", async () => {
    const mock = viewMock();
    const steering = {
      ...queued,
      state: "Recovered · confirmation required",
      actions: [{ value: "resume", label: "Apply recovered steering…" }],
    };
    const mutate = vi.fn();
    const rpc = remote({
      "execution.read": (p) =>
        p.id ? steering : p.kind === "steering" ? [steering] : [],
      "execution.hold": () => ({ token: "steering-hold" }),
      "execution.release": () => ({}),
      "execution.action": mutate,
    });
    const selected = (
      await detail(
        attachedWorkspaceSources(mock.view, rpc.client, session.id).Activity,
      )
    ).detail;
    mock.panel.choose.mockResolvedValueOnce({ value: "confirm" });
    await action(selected, "resume").run();
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "steering",
        action: "resume",
        token: "steering-hold",
        sessionId: session.id,
      }),
    );
    mock.panel.choose.mockImplementationOnce(async () => {
      rpc.status.sessionRole = "view";
      return { value: "confirm" };
    });
    await expect(action(selected, "resume").run()).rejects.toThrow("read-only");
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("reads one history page per refresh, explicitly navigates older runs, and never offers replay", async () => {
    const mock = viewMock();
    const rpc = remote({
      "execution.read": () => [],
      "execution.history": (p) =>
        p.before
          ? {
              snapshot: 20,
              nextBefore: null,
              items: [{ ...queued, id: "old-run", title: "Old run" }],
            }
          : { snapshot: 20, nextBefore: 10, items: [] },
      "execution.history.detail": (p) => {
        expect(p.snapshot).toBe(20);
        return {
          ...queued,
          id: "old-run",
          detail: "No recorded end event",
          actions: [{ value: "resume", label: "Replay" }],
        };
      },
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Activity;
    expect(await source.load(signal())).toEqual([]);
    expect(
      rpc.request.mock.calls.filter(
        ([method]) => method === "execution.history",
      ),
    ).toHaveLength(1);
    await source
      .actions!.find((action) => action.id === "history.earlier")!
      .run();
    const selected = (await detail(source)).detail;
    expect(selected.text).toContain("No recorded end event");
    expect(selected.actions?.map((action) => action.id)).toEqual(["reference"]);
    await source.load(signal());
    expect(
      rpc.request.mock.calls
        .filter(([method]) => method === "execution.history")
        .map(([, p]) => [p.snapshot, p.before]),
    ).toEqual([
      [undefined, undefined],
      [20, 10],
      [20, 10],
    ]);
    await source.actions!.find((action) => action.id === "history.all")!.run();
    expect(mock.raw.command).toHaveBeenCalledWith("/tasks history");
  });
});

describe("workbench Plan and Context", () => {
  it("opens actual version, question, change, and tool-evidence objects", async () => {
    const mock = viewMock();
    const evidenceText = "a".repeat(15999) + "😀2 tests passed";
    const tool = {
      sessionId: session.id,
      seq: 9,
      callId: "call-a",
      name: "test",
      status: "completed",
      step: 1,
      preview: "2 passed",
    };
    const plan = {
      id: "plan-a",
      title: "Auth",
      steps: ["Add tests"],
      validation: "Run tests",
    };
    const entry = {
      ...change,
      origin: {
        callId: tool.callId,
        plan: { sessionId: session.id, planId: plan.id, step: 1 },
      },
    };
    const rpc = remote({
      "plan.read": () => ({
        active: true,
        plan,
        progress: {
          planId: plan.id,
          steps: [
            {
              text: "Add tests",
              status: "completed",
              evidence: { reliable: 1, observed: 0, tools: [tool] },
            },
          ],
        },
      }),
      "plan.history": () => ({
        items: [{ id: "older", title: "Original", revision: 1 }],
        nextBefore: null,
      }),
      "plan.version": () => ({
        ...plan,
        title: "Original",
        steps: ["Explore auth"],
      }),
      "plan.evidence": (p) => ({
        data: evidenceText.slice(Number(p.offset), Number(p.offset) + 16000),
        total: evidenceText.length,
        nextOffset:
          Number(p.offset) + 16000 < evidenceText.length
            ? Number(p.offset) + 16000
            : null,
      }),
      "questions.read": () => ({
        id: "question-a",
        questions: [
          { id: "q", question: "Which timeout?", options: ["1s", "2s"] },
        ],
      }),
      "questions.respond": () => ({}),
      "changes.review.list": () => ({ items: [entry], more: false }),
      "changes.review.diff": () => ({
        entry,
        data: "diff",
        total: 4,
        nextOffset: null,
      }),
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Plan;
    const items = await source.load(signal());
    const step = await source.detail(
      items.find((item) => item.id === "step:1")!,
      signal(),
    );
    expect(step.text).toContain("not independent verification");
    await step.actions![0]!.run();
    expect(mock.raw.openWorkspaceObject).toHaveBeenLastCalledWith(
      "Changes",
      'change:["session-a","file","change-a"]',
    );
    await step.actions![1]!.run();
    expect(mock.raw.openWorkspaceObject).toHaveBeenLastCalledWith(
      "Plan",
      'evidence:["session-a","plan-a",9]',
    );
    const evidence = await source.detail(
      items.find((item) => item.id.startsWith("evidence:"))!,
      signal(),
    );
    expect(evidence.text.endsWith("a")).toBe(true);
    await action(evidence, "next").run();
    expect(
      (
        await source.detail(
          items.find((item) => item.id.startsWith("evidence:"))!,
          signal(),
        )
      ).text,
    ).toContain("😀2 tests passed");
    const version = await source.detail(
      items.find((item) => item.id === "version:older")!,
      signal(),
    );
    expect(version.text).toContain("Explore auth");
    const question = await source.detail(
      items.find((item) => item.id === "question:question-a")!,
      signal(),
    );
    await action(question, "answer").run();
    expect(mock.raw.command).toHaveBeenCalledWith("/questions");
  });

  it("lists draft references outside code, pages resources, and preserves draft on reference", async () => {
    const mock = viewMock();
    mock.raw.editor.setText(
      'Please read @"src/auth module.ts" and `@not-a-file`',
    );
    const rpc = remote({
      "resources.list": (p) =>
        p.offset
          ? {
              items: [
                { name: "read", kind: "Tool", description: "Read a file" },
              ],
              hasMore: false,
            }
          : {
              items: [
                {
                  name: "Rules",
                  kind: "Instructions",
                  path: "/workspace/AGENTS.md",
                  description: "Workspace instructions",
                },
              ],
              hasMore: true,
            },
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Context;
    mock.raw.options.previewAttachment = vi.fn(
      async () => "Secure preview: function authenticate() {}",
    );
    const items = await source.load(signal());
    expect(
      items
        .filter((item) => item.group === "Draft attachment")
        .map((item) => item.id),
    ).toEqual(['attachment:"src/auth module.ts"']);
    expect(items.some((item) => item.title === "read")).toBe(true);
    const attachment = await source.detail(
      items.find((item) => item.group === "Draft attachment")!,
      signal(),
    );
    expect(attachment.text).toContain(
      "Secure preview: function authenticate()",
    );
    await action(attachment, "remove").run();
    expect(mock.raw.removeDraftAttachment).toHaveBeenCalledWith(
      "src/auth module.ts",
    );
    const resource = await source.detail(
      items.find((item) => item.title === "Rules")!,
      signal(),
    );
    await action(resource, "reference").run();
    expect(mock.raw.editor.getExpandedText()).toBe(
      'Please read @"src/auth module.ts" and `@not-a-file`\n\n@"/workspace/AGENTS.md"',
    );
    mock.raw.editor.setText("No attachment");
    await expect(
      source.detail(
        items.find((item) => item.group === "Draft attachment")!,
        signal(),
      ),
    ).rejects.toThrow("no longer present");
  });

  it("rejects an aborted load without publishing its stale results", async () => {
    const mock = viewMock();
    const controller = new AbortController();
    const rpc = remote({
      "resources.list": () => {
        controller.abort();
        return { items: [], hasMore: false };
      },
    });
    await expect(
      attachedWorkspaceSources(mock.view, rpc.client, session.id).Context.load(
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("rejects a selected object's action after its inspector was closed", async () => {
    const mock = viewMock();
    const rpc = remote({
      "changes.review.list": () => ({ items: [change], more: false }),
      "changes.review.diff": () => ({
        entry: change,
        data: "diff",
        total: 4,
        nextOffset: null,
      }),
    });
    const source = attachedWorkspaceSources(
      mock.view,
      rpc.client,
      session.id,
    ).Changes;
    const items = await source.load(signal());
    const controller = new AbortController();
    const selected = await source.detail(items[0]!, controller.signal);
    controller.abort();
    expect(() => action(selected, "reference").run()).toThrow();
    expect(mock.raw.editor.getExpandedText()).toBe("");
  });
});

describe("native workbench projection", () => {
  it("uses the native journal and refuses stale-session actions without an RPC adapter", async () => {
    const mock = viewMock();
    let selected = session;
    const rollback = vi.fn();
    const runtime = {
      review: {
        list: async () => ({ items: [change], warnings: [] }),
        detail: async () => ({ entry: change, before: "old", after: "new" }),
      },
      rollbackChange: rollback,
    } as unknown as Runtime;
    const source = nativeWorkspaceSources(
      mock.view,
      runtime,
      () => selected,
      {} as Agent,
    ).Changes;
    const selectedDetail = (await detail(source)).detail;
    expect(selectedDetail.text).toContain("-old");
    expect(selectedDetail.text).toContain("+new");
    selected = { ...session, id: "session-b" };
    await expect(action(selectedDetail, "rollback").run()).rejects.toThrow(
      "no longer current",
    );
    expect(rollback).not.toHaveBeenCalled();
    expect(mock.panel.choose).not.toHaveBeenCalled();
  });

  it("uses a short native hold, releases on mutation failure, and protects Plan-mode terminal input", async () => {
    const mock = viewMock();
    const release = vi.fn(),
      update = vi.fn(async () => {
        throw Error("write failed");
      }),
      send = vi.fn();
    const agent = {
      pendingPrompts: () => [{ id: "q1", text: "Fix auth", attachments: 0 }],
      pendingSteering: () => [],
      holdQueue: vi.fn(() => release),
      updatePending: update,
    } as unknown as Agent;
    const runtime = {
      loadChildTasks: async () => {},
      loadTerminals: async () => {},
      childTasks: () => [],
      terminalList: () => [
        {
          id: "term",
          command: "shell",
          state: "running",
          cleanup: "pending",
          output: "",
        },
      ],
      executionHistoryPage: async () => ({
        items: [],
        snapshot: 0,
        nextBefore: null,
      }),
      planning: { load: async () => {}, get: () => ({ active: true }) },
      terminals: { send },
    } as unknown as Runtime;
    const source = nativeWorkspaceSources(
      mock.view,
      runtime,
      session,
      agent,
    ).Activity;
    const queueDetail = (await detail(source, (id) => id.startsWith("queue:")))
      .detail;
    expect(agent.holdQueue).not.toHaveBeenCalled();
    await expect(action(queueDetail, "edit").run()).rejects.toThrow(
      "write failed",
    );
    expect(release).toHaveBeenCalledTimes(1);
    const terminalDetail = (
      await detail(source, (id) => id.startsWith("terminals:"))
    ).detail;
    mock.panel.choose.mockResolvedValueOnce({ value: "confirm" });
    await expect(action(terminalDetail, "send").run()).rejects.toThrow(
      "Plan mode is read-only",
    );
    expect(send).not.toHaveBeenCalled();
    expect(agent.holdQueue).toHaveBeenCalledTimes(1);
  });
});
