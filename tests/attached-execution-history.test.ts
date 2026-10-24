import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { AttachedWorkflows } from "../apps/cli/src/attached-workflows.ts";
import type { ClientConnection } from "../packages/client-core/src/connection.ts";
import type { RpcMethod } from "../packages/protocol/src/contracts.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const item = (id = "retained-old-run") => ({
  id,
  title: `Saved run ${id}`,
  state: "failed",
  detail: `Original failure for ${id}`,
  actions: [],
});
type Sent = { method: RpcMethod; params: Record<string, unknown> };
function fixture(
  options: {
    role?: "owner" | "view";
    capabilities?: "new" | "old" | "list-only";
    beforeSend?: (request: Sent) => Promise<void>;
    afterSend?: (request: Sent) => Promise<void>;
  } = {},
) {
  const state = {
    canAct: true,
    session: { id: "selected-session" },
    sessionRole: options.role ?? "owner",
    busy: false,
  };
  const sent: Sent[] = [];
  const request = vi.fn(
    async (
      method: RpcMethod,
      params: Record<string, unknown>,
      callbacks?: { beforeSend?: () => void },
    ) => {
      const command = { method, params };
      await options.beforeSend?.(command);
      callbacks?.beforeSend?.();
      sent.push(command);
      await options.afterSend?.(command);
      if (method === "execution.history")
        return { items: [item()], snapshot: 500, nextBefore: null };
      if (method === "execution.history.detail") return item(String(params.id));
      if (method === "execution.hold") return { token: "manager-hold" };
      if (method === "execution.release") return { released: true };
      if (method === "execution.read")
        return params.id ? item(String(params.id)) : [item()];
      if (method === "questions.read") return null;
      if (method === "plan.read") return { active: false };
      throw Error(`Unexpected request: ${method}`);
    },
  );
  const client = {
    state,
    request,
    supports(method: string) {
      const capabilities = options.capabilities ?? "new";
      return capabilities === "new"
        ? ["execution.history", "execution.history.detail"].includes(method)
        : capabilities === "list-only" && method === "execution.history";
    },
  } as unknown as ClientConnection;
  let current!: { panel: ModelPanel; controller: AbortController };
  const setError = vi.fn();
  const openModelPanel = vi.fn(() => {
    const controller = new AbortController();
    const panel = new ModelPanel(controller.signal, () => {});
    current = { panel, controller };
    return {
      panel,
      signal: controller.signal,
      close: () => controller.abort(),
    };
  });
  const view = {
    openModelPanel,
    closeModelPanel: () => current?.controller.abort(),
    setError,
    notice: vi.fn(),
    setPermissionLabel: vi.fn(),
  } as unknown as HikaroView;
  const workflows = new AttachedWorkflows(client, view, "/workspace");
  const screen = () =>
    stripVTControlCharacters(current.panel.render(120).join("\n"));
  return {
    state,
    sent,
    request,
    workflows,
    setError,
    openModelPanel,
    screen,
    panel: () => current.panel,
    abort: () => current.controller.abort(),
    wait: (text: string) => vi.waitFor(() => expect(screen()).toContain(text)),
    choose(index: number) {
      for (let step = 0; step < index; step++)
        current.panel.handleInput("\x1b[B");
      current.panel.handleInput("\r");
    },
  };
}

it.each(["owner", "view"] as const)(
  "opens complete attached history for %s without holding or mutating the queue",
  async (role) => {
    vi.useFakeTimers();
    const f = fixture({ role });
    const work = f.workflows.command("/tasks", "history");
    try {
      await f.wait("Execution history · page 1");
      expect(f.screen()).toContain("Saved run retained-old-run");
      f.choose(0);
      await f.wait("Original failure for retained-old-run");
      expect(f.sent).toEqual([
        {
          method: "execution.history",
          params: { sessionId: "selected-session" },
        },
        {
          method: "execution.history.detail",
          params: {
            id: "retained-old-run",
            snapshot: 500,
            sessionId: "selected-session",
          },
        },
      ]);
      expect(f.screen()).not.toMatch(/Stop run|Resume run|Execute run/);
      expect(f.panel().cancelStep()).toBe(true);
      await f.wait("Execution history · page 1");
      expect(f.panel().cancelStep()).toBe(true);
      await work;
      expect(
        f.sent.every(({ method }) => method.startsWith("execution.history")),
      ).toBe(true);
      expect(f.setError).not.toHaveBeenCalled();
    } finally {
      f.workflows.close();
      await work;
      vi.useRealTimers();
    }
  },
);

it("opens an exact ID directly with a view role and no list or hold request", async () => {
  vi.useFakeTimers();
  const f = fixture({ role: "view" });
  const work = f.workflows.command("/tasks", "history old-run-outside-window");
  try {
    await f.wait("Original failure for old-run-outside-window");
    expect(f.sent).toEqual([
      {
        method: "execution.history.detail",
        params: {
          id: "old-run-outside-window",
          snapshot: undefined,
          sessionId: "selected-session",
        },
      },
    ]);
    expect(f.setError).not.toHaveBeenCalled();
  } finally {
    f.workflows.close();
    await work;
    vi.useRealTimers();
  }
});

it.each(["old", "list-only"] as const)(
  "requires both new capabilities and preserves explicitly bounded recent history for a %s host",
  async (capabilities) => {
    vi.useFakeTimers();
    const f = fixture({ capabilities });
    let work: Promise<void> | undefined;
    try {
      await expect(
        f.workflows.command("/tasks", "history older-run"),
      ).rejects.toThrow("Upgrade the host");
      expect(f.sent).toEqual([]);
      expect(f.openModelPanel).not.toHaveBeenCalled();
      work = f.workflows.command("/tasks", "");
      await f.wait("Execution manager");
      expect(f.screen()).toContain("Recent execution history");
      f.choose(4);
      await f.wait("Recent execution history · page 1");
      expect(f.screen()).toContain("latest 200 run events, up to 100 runs");
      expect(f.screen()).toContain("Upgrade the host");
      f.choose(0);
      await f.wait("Original failure for retained-old-run");
      expect(
        f.sent
          .filter(({ method }) => method === "execution.read")
          .map(({ params }) => params),
      ).toEqual([
        {
          kind: "history",
          token: "manager-hold",
          sessionId: "selected-session",
        },
        {
          kind: "history",
          id: "retained-old-run",
          token: "manager-hold",
          sessionId: "selected-session",
        },
      ]);
      expect(
        f.sent.some(({ method }) => method.startsWith("execution.history")),
      ).toBe(false);
      expect(f.panel().cancelStep()).toBe(true);
      await f.wait("Recent execution history · page 1");
      expect(f.panel().cancelStep()).toBe(true);
      await f.wait("Execution manager");
      f.choose(5);
      await work;
      expect(f.sent.at(-1)).toEqual({
        method: "execution.release",
        params: { token: "manager-hold", sessionId: "selected-session" },
      });
      expect(f.setError).not.toHaveBeenCalled();
    } finally {
      f.workflows.close();
      await work;
      vi.useRealTimers();
    }
  },
);

it.each(["close", "session"] as const)(
  "does not send a delayed history request after %s invalidates its panel or selected session",
  async (transition) => {
    vi.useFakeTimers();
    const gate = deferred();
    const f = fixture({
      beforeSend: async ({ method }) => {
        if (method === "execution.history") await gate.promise;
      },
    });
    const work = f.workflows.command("/tasks", "history");
    const choose = vi.spyOn(f.panel(), "choose");
    try {
      expect(f.screen()).toContain("Loading execution history");
      if (transition === "close") f.abort();
      else f.state.session = { id: "new-session" };
      gate.resolve();
      await work;
      expect(f.sent).toEqual([]);
      expect(choose).not.toHaveBeenCalled();
      if (transition === "close") expect(f.setError).not.toHaveBeenCalled();
      else
        expect(f.setError).toHaveBeenCalledWith(
          expect.stringContaining("changed"),
        );
    } finally {
      gate.resolve();
      f.workflows.close();
      await work;
      vi.useRealTimers();
    }
  },
);

it.each(["close", "session"] as const)(
  "does not render delayed history details after %s invalidates their destination",
  async (transition) => {
    vi.useFakeTimers();
    const gate = deferred();
    const f = fixture({
      afterSend: async ({ method }) => {
        if (method === "execution.history.detail") await gate.promise;
      },
    });
    const work = f.workflows.command("/tasks", "history old-run");
    const read = vi.spyOn(f.panel(), "readDocument");
    try {
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      if (transition === "close") f.abort();
      else f.state.session = { id: "new-session" };
      gate.resolve();
      await work;
      expect(read).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(1);
      expect(f.screen()).not.toContain("Original failure");
      if (transition === "close") expect(f.setError).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      f.workflows.close();
      await work;
      vi.useRealTimers();
    }
  },
);
