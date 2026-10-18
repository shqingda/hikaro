import { expect, it, vi } from "vitest";
import { TerminalManager } from "../packages/tools/src/terminal.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { openExecutionControl } from "../packages/tui/src/execution-control.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
it("manages a queued message through the panel and resumes dispatch on close", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  let queue = [{ id: "one", text: "original", attachments: 0 }];
  const release = vi.fn();
  const source = {
    agent: {
      holdQueue: () => release,
      pendingPrompts: () => queue,
      updatePending: (_id: string, text: string) => {
        queue[0]!.text = text;
      },
      prioritizePending: () => {},
      removePending: () => {
        queue = [];
      },
    },
    runtime: {
      terminals: new TerminalManager(),
      childTasks: () => [],
      stopChild: () => {},
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
