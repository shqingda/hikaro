import { expect, it, vi } from "vitest";
import { TerminalManager } from "../packages/tools/src/terminal.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { openExecutionControl } from "../packages/tui/src/execution-control.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
it("manages a queued message through the panel and resumes dispatch on close", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  let queue = [
    { id: "one", text: "original", attachments: 0, recovered: false },
  ];
  const release = vi.fn();
  const source = {
    agent: {
      holdQueue: () => release,
      pendingPrompts: () => queue,
      pendingSteering: () => [],
      updateSteering: async () => {},
      prioritizeSteering: async () => {},
      removeSteering: async () => {},
      resumeSteering: async () => {},
      updatePending: async (_id: string, text: string) => {
        queue[0]!.text = text;
      },
      prioritizePending: async () => {},
      resumePending: async () => {},
      removePending: async () => {
        queue = [];
      },
    },
    runtime: {
      terminals: new TerminalManager(),
      childTasks: () => [],
      stopChild: () => {},
      executionHistory: async () => [],
    },
    session: "s",
  };
  const view = {
    openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
    notice: vi.fn(),
    setError: vi.fn(),
  } as unknown as HikaroView;
  const work = openExecutionControl(view, source);
  const wait = async (text: string) =>
    vi.waitFor(() => expect(panel.render(100).join("\n")).toContain(text));
  await wait("Execution manager");
  panel.handleInput("\r");
  await wait("Pending messages");
  panel.handleInput("\r");
  await wait("Edit message");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Edit pending message");
  panel.handleInput("\x01");
  panel.handleInput("\x0b");
  panel.handleInput("updated");
  panel.handleInput("\r");
  await wait("Message updated");
  expect(queue[0]!.text).toBe("updated");
  abort.abort();
  await work;
  expect(release).toHaveBeenCalledOnce();
  expect(view.setError).not.toHaveBeenCalled();
});

it("shows loading between asynchronous screens and ignores premature input", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  const listed =
    deferred<
      import("../packages/runtime/src/execution-items.ts").ExecutionItem[]
    >();
  const detailed =
    deferred<
      import("../packages/runtime/src/execution-items.ts").ExecutionItem
    >();
  const item = {
    id: "one",
    title: "Message",
    state: "queued",
    detail: "Full message",
    editText: "Full message",
    actions: [{ value: "edit", label: "Edit message" }],
  };
  const release = vi.fn(async () => {});
  const detail = vi.fn(() => detailed.promise);
  const act = vi.fn(async () => {});
  const view = {
    openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
    notice: vi.fn(),
    setError: vi.fn(),
  } as unknown as HikaroView;
  const work = openExecutionControl(view, {
    hold: async () => release,
    list: () => listed.promise,
    detail,
    act,
  });
  const screen = () => panel.render(100).join("\n");
  try {
    await vi.waitFor(() => expect(screen()).toContain("Execution manager"));
    panel.handleInput("\r");
    await vi.waitFor(() =>
      expect(screen()).toContain("Loading pending messages"),
    );
    expect(screen()).not.toContain("Close and resume queue");
    panel.handleInput("\r");
    expect(detail).not.toHaveBeenCalled();
    listed.resolve([item]);
    await vi.waitFor(() =>
      expect(screen()).toContain("Pending messages · page 1"),
    );
    panel.handleInput("\r");
    await vi.waitFor(() => expect(screen()).toContain("Loading details"));
    expect(screen()).not.toContain("Back to manager");
    panel.handleInput("\r");
    expect(act).not.toHaveBeenCalled();
    detailed.resolve(item);
    await vi.waitFor(() => expect(screen()).toContain("Edit message"));
  } finally {
    abort.abort();
    listed.resolve([item]);
    detailed.resolve(item);
    await work;
  }
  expect(release).toHaveBeenCalledOnce();
  expect(view.setError).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
