import { expect, it, vi } from "vitest";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { browseExecutionHistory } from "../packages/tui/src/execution-history.ts";
import { openExecutionControl } from "../packages/tui/src/execution-control.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

function setup() {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  const view = {
    openModelPanel: () => ({
      panel,
      signal: abort.signal,
      close: () => abort.abort(),
    }),
    setError: vi.fn(),
  } as unknown as HikaroView;
  return { abort, panel, view, screen: () => panel.render(120).join("\n") };
}
const item = (id: string) => ({
  id,
  title: `Run ${id}`,
  state: "completed",
  detail: `Saved detail ${id}`,
  actions: [],
});
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

it.each(["history", "manager"] as const)(
  "does not open or reject a %s reader invalidated before its panel opens",
  async (kind) => {
    const { view } = setup();
    const open = vi.spyOn(view, "openModelPanel");
    const selection = new AbortController();
    selection.abort();
    const list = vi.fn(async () => ({
      items: [],
      snapshot: 0,
      nextBefore: null,
    }));
    const hold = vi.fn(async () => async () => {});
    const work =
      kind === "history"
        ? browseExecutionHistory(
            view,
            { list, detail: async (id) => item(id) },
            undefined,
            selection.signal,
          )
        : openExecutionControl(
            view,
            {
              hold,
              list: async () => [],
              detail: async (_kind, id) => item(id),
              act: async () => {},
            },
            selection.signal,
          );
    await expect(work).resolves.toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(view.setError).not.toHaveBeenCalled();
  },
);

it("crosses an empty page, retains snapshot on previous/detail, and refreshes from a new snapshot", async () => {
  const { panel, view, abort, screen } = setup();
  let fresh = 0;
  const list = vi.fn(async (cursor: { snapshot?: number; before?: number }) => {
    if (cursor.before === 200)
      return { items: [item("next")], snapshot: 500, nextBefore: null };
    if (cursor.snapshot === undefined) fresh++;
    return { items: [], snapshot: fresh > 1 ? 600 : 500, nextBefore: 200 };
  });
  const detail = vi.fn(async (id: string) => item(id));
  const work = browseExecutionHistory(view, { list, detail });
  const wait = async (text: string) =>
    vi.waitFor(() => expect(screen()).toContain(text));
  try {
    await wait("Execution history · page 1");
    expect(screen()).toContain("More source events remain");
    panel.handleInput("\r");
    await wait("Execution history · page 2");
    expect(list.mock.calls[1]![0]).toEqual({ snapshot: 500, before: 200 });
    panel.handleInput("\r");
    await wait("Saved detail next");
    expect(detail).toHaveBeenCalledWith("next", 500, abort.signal);
    panel.cancelStep();
    await wait("Execution history · page 2");
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    await wait("Execution history · page 1");
    expect(list.mock.lastCall![0]).toEqual({
      snapshot: 500,
      before: undefined,
    });
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    await vi.waitFor(() => expect(fresh).toBe(2));
    expect(list.mock.lastCall![0]).toEqual({});
  } finally {
    abort.abort();
    await work;
  }
  expect(view.setError).not.toHaveBeenCalled();
});

it("opens an exact old ID without listing first and ignores any supplied execution actions", async () => {
  const { view, panel, abort, screen } = setup();
  const list = vi.fn(async () => ({
    items: [],
    snapshot: 1,
    nextBefore: null,
  }));
  const detail = vi.fn(async (id: string) => ({
    ...item(id),
    actions: [{ value: "stop", label: "Stop run" }],
  }));
  const work = browseExecutionHistory(view, { list, detail }, "old-run-id");
  try {
    await vi.waitFor(() =>
      expect(screen()).toContain("Saved detail old-run-id"),
    );
    expect(list).not.toHaveBeenCalled();
    expect(detail).toHaveBeenCalledWith("old-run-id", undefined, abort.signal);
    expect(screen()).not.toContain("Stop run");
    panel.cancelStep();
    await vi.waitFor(() => expect(screen()).toContain("No saved runs"));
  } finally {
    abort.abort();
    await work;
  }
  expect(view.setError).not.toHaveBeenCalled();
});

it("does not render a delayed history response after the panel closes", async () => {
  const { view, panel, abort, screen } = setup();
  let resolve!: (page: {
    items: ReturnType<typeof item>[];
    snapshot: number;
    nextBefore: null;
  }) => void;
  const response = new Promise<{
    items: ReturnType<typeof item>[];
    snapshot: number;
    nextBefore: null;
  }>((done) => {
    resolve = done;
  });
  const choose = vi.spyOn(panel, "choose");
  const work = browseExecutionHistory(view, {
    list: () => response,
    detail: async (id) => item(id),
  });
  await tick();
  expect(screen()).toContain("Loading execution history");
  abort.abort();
  resolve({ items: [item("late")], snapshot: 1, nextBefore: null });
  await work;
  expect(choose).not.toHaveBeenCalled();
  expect(view.setError).not.toHaveBeenCalled();
});

it("closes the original panel and suppresses a late read error after its session is invalidated", async () => {
  const { view, abort } = setup();
  const selection = new AbortController();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const work = browseExecutionHistory(
    view,
    {
      list: () => pending,
      detail: async (id) => item(id),
    },
    undefined,
    selection.signal,
  );
  selection.abort();
  expect(abort.signal.aborted).toBe(true);
  reject(Error("Old session read failed"));
  await work;
  expect(view.setError).not.toHaveBeenCalled();
});

it.each(["snapshot", "cursor"] as const)(
  "rejects a changed %s instead of continuing an inconsistent history",
  async (invalid) => {
    const { view, panel, screen } = setup();
    let reads = 0;
    const list = vi.fn(async () => {
      reads++;
      return reads === 1
        ? { items: [], snapshot: 500, nextBefore: 200 }
        : {
            items: [],
            snapshot: invalid === "snapshot" ? 501 : 500,
            nextBefore: 200,
          };
    });
    const work = browseExecutionHistory(view, {
      list,
      detail: async (id) => item(id),
    });
    await vi.waitFor(() => expect(screen()).toContain("Next page"));
    panel.handleInput("\r");
    await work;
    expect(reads).toBe(2);
    expect(view.setError).toHaveBeenCalledWith(
      expect.stringContaining(
        invalid === "snapshot" ? "snapshot changed" : "Invalid history cursor",
      ),
    );
  },
);
