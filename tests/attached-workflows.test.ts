import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../packages/runtime/src/index.ts";
import { RpcWorkflows } from "../apps/cli/src/rpc-workflows.ts";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { AttachedWorkflows } from "../apps/cli/src/attached-workflows.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
import { stripVTControlCharacters } from "node:util";

it("does not send an old answer after the same question changes to recovered during beforeSend waits", async () => {
  vi.useFakeTimers();
  let recovered = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let panel: ModelPanel, controller: AbortController;
  const sent: unknown[] = [];
  const request = vi.fn(
    async (
      method: string,
      params: Record<string, unknown>,
      options?: { beforeSend?: () => void },
    ) => {
      if (method === "questions.respond") {
        await waiting;
        options?.beforeSend?.();
        sent.push(params);
        return { completed: true, recovered };
      }
      options?.beforeSend?.();
      if (method === "questions.read")
        return {
          id: "same-question",
          questions: [{ id: "q", question: "Choose", options: ["A"] }],
          recovered,
        };
      return { active: true };
    },
  );
  const client = {
    state: {
      canAct: true,
      session: { id: "session" },
      sessionRole: "owner",
      busy: true,
    },
    request,
    supports: () => false,
  } as unknown as ClientConnection;
  const view = {
    openModelPanel() {
      const current = new AbortController();
      controller = current;
      panel = new ModelPanel(current.signal, () => {});
      return { panel, signal: current.signal, close: () => current.abort() };
    },
    closeModelPanel: () => controller?.abort(),
    notice: vi.fn(),
    setError: vi.fn(),
    setPermissionLabel: vi.fn(),
  } as unknown as HikaroView;
  const workflows = new AttachedWorkflows(client, view, "/tmp");
  const screen = () => stripVTControlCharacters(panel.render(110).join("\n"));
  try {
    await vi.advanceTimersByTimeAsync(750);
    expect(screen()).toContain("Question 1/1");
    panel!.handleInput("\x1b[B");
    panel!.handleInput("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(screen()).toContain("Review answers");
    panel!.handleInput("\x1b[B");
    panel!.handleInput("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      request.mock.calls.filter(([method]) => method === "questions.respond"),
    ).toHaveLength(1);
    recovered = true;
    await vi.advanceTimersByTimeAsync(1500);
    release();
    await vi.advanceTimersByTimeAsync(750);
    expect(sent).toEqual([]);
    expect(screen()).toContain("Recovered question 1/1");
  } finally {
    release();
    workflows.close();
    vi.useRealTimers();
  }
});

it.each(["poll", "response"] as const)(
  "shows same-question recovery through the %s without claiming the old run resumed",
  async (transition) => {
    vi.useFakeTimers();
    let recovered = false,
      pending = true;
    let panel: ModelPanel, controller: AbortController;
    const notice = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "questions.read")
        return pending
          ? {
              id: "same-question",
              questions: [{ id: "q", question: "Choose", options: ["A"] }],
              recovered,
            }
          : null;
      if (method === "questions.respond") {
        pending = false;
        return { completed: true, recovered };
      }
      return { active: true };
    });
    const client = {
      state: {
        canAct: true,
        session: { id: "session" },
        sessionRole: "owner",
        busy: true,
      },
      request,
      supports: () => false,
    } as unknown as ClientConnection;
    const view = {
      openModelPanel() {
        const current = new AbortController();
        controller = current;
        panel = new ModelPanel(current.signal, () => {});
        return { panel, signal: current.signal, close: () => current.abort() };
      },
      closeModelPanel: () => controller?.abort(),
      notice,
      setError: vi.fn(),
      setPermissionLabel: vi.fn(),
    } as unknown as HikaroView;
    const workflows = new AttachedWorkflows(client, view, "/tmp");
    const screen = () => stripVTControlCharacters(panel.render(110).join("\n"));
    try {
      await vi.advanceTimersByTimeAsync(750);
      expect(screen()).toContain("Question 1/1");
      const previous = controller!;
      recovered = true;
      if (transition === "poll") {
        await vi.advanceTimersByTimeAsync(1500);
        expect(previous.signal.aborted).toBe(true);
        expect(screen()).toContain("Recovered question 1/1");
        expect(
          request.mock.calls.filter(
            ([method]) => method === "questions.respond",
          ),
        ).toEqual([]);
      }
      panel!.handleInput("\x1b[B");
      panel!.handleInput("\r");
      await vi.advanceTimersByTimeAsync(0);
      expect(screen()).toContain("Review answers");
      panel!.handleInput("\x1b[B");
      panel!.handleInput("\r");
      await vi.advanceTimersByTimeAsync(0);
      expect(notice).toHaveBeenCalledWith(
        expect.stringContaining("Recovered answers saved"),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "questions.respond"),
      ).toHaveLength(1);
    } finally {
      workflows.close();
      vi.useRealTimers();
    }
  },
);

it("chunks snapshots, scopes pending questions, and expires abandoned queue holds", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-workflows-")),
  );
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  const workflows = new RpcWorkflows(runtime);
  try {
    const session = await runtime.session(),
      other = await runtime.session();
    const agent = await runtime.agent(session);
    const otherAgent = await runtime.agent(other);
    const invoke = (method: string, p: Record<string, unknown> = {}) =>
      workflows.handle(method, p, session, agent, "one");
    await writeFile(join(home, "sample"), "before");
    await runtime.changes.update(
      session.id,
      join(home, "sample"),
      new AbortController().signal,
      () => "after".repeat(10000),
    );
    const list = (await invoke("changes.list")) as { items: { id: string }[] };
    let text = "";
    for (let offset = 0; offset < 50000; offset += 16000) {
      const part = (await invoke("changes.detail", {
        id: list.items[0]!.id,
        offset,
      })) as { text: string };
      expect(part.text.length).toBeLessThanOrEqual(16000);
      text += part.text;
    }
    expect(text).toBe("after".repeat(10000));
    await invoke("changes.rollback", { id: list.items[0]!.id });
    expect(await readFile(join(home, "sample"), "utf8")).toBe("before");
    const records = await runtime.changes.list(session.id);
    const listing = vi.spyOn(runtime.changes, "list").mockResolvedValueOnce(
      Array.from({ length: 100 }, () => ({
        ...records[0]!,
        path: "/" + "\u0001".repeat(3000),
      })),
    );
    const page = (await invoke("changes.list")) as {
      items: unknown[];
      more: boolean;
    };
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128100);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.more).toBe(true);
    listing.mockRestore();
    const abort = new AbortController();
    const answers = workflows.ask(
      [{ id: "q", question: "Choose", options: ["A", "B"] }],
      abort.signal,
      session.id,
      "one",
    );
    const question = (await invoke("questions.read")) as { id: string };
    await expect(
      workflows.handle(
        "questions.respond",
        { id: question.id, answers: { q: "A" } },
        other,
        otherAgent,
        "two",
      ),
    ).rejects.toThrow(/expired/);
    await invoke("questions.respond", {
      id: question.id,
      answers: { q: "custom" },
    });
    expect(await answers).toEqual({ q: "custom" });
    await expect(
      invoke("questions.respond", { id: question.id, answers: { q: "B" } }),
    ).rejects.toThrow(/expired/);
    const cancelled = workflows.ask(
      [{ id: "q", question: "Again?" }],
      abort.signal,
      session.id,
      "one",
    );
    abort.abort();
    expect(await cancelled).toBeUndefined();
    vi.useFakeTimers();
    const hold = (await invoke("execution.hold")) as { token: string };
    await vi.advanceTimersByTimeAsync(15001);
    vi.useRealTimers();
    await expect(
      invoke("execution.action", {
        kind: "queue",
        id: "missing",
        action: "remove",
        token: hold.token,
      }),
    ).rejects.toThrow(/expired/);
  } finally {
    vi.useRealTimers();
    workflows.close();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("uses durable host receipts and rejects cross-selection workflow commands", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-workflow-host-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const seed = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => true,
  });
  const session = await seed.session();
  await seed.agent(session);
  await seed.setPlanning(session, true);
  const plan = await seed.planning.propose(session.id, {
    title: "Inspect",
    steps: ["Explain"],
    validation: "Review",
  });
  await seed.close();
  const host = await serveSharedHost({ home, cwd, demo: true });
  const transport = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "test",
  });
  const client = new ClientConnection(transport.scope, transport, {
    id: randomUUID,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  });
  try {
    await client.connected();
    await client.request("session.resume", { sessionId: session.id });
    expect(
      await client.request("plan.read", { sessionId: session.id }),
    ).toMatchObject({ active: true, plan: { id: plan.id } });
    await expect(
      client.request("plan.set", { sessionId: randomUUID(), active: false }),
    ).rejects.toThrow(/selected/);
    await client.request("plan.execute", {
      sessionId: session.id,
      id: plan.id,
    });
    await vi.waitFor(async () => {
      expect(
        (
          (await client.request("plan.read", { sessionId: session.id })) as {
            active: boolean;
          }
        ).active,
      ).toBe(false);
      expect(client.state.busy).toBe(false);
    });
    const receipts = client.receipts.filter((r) => r.method === "plan.execute");
    expect(receipts.length).toBeGreaterThan(0);
    const executed = receipts[0]!;
    await vi.waitFor(async () => {
      expect(
        await transport.request("command.receipt", { commandId: executed.id }),
      ).toMatchObject({ receipt: { status: "completed" } });
    });
    // The accepted command can precede run.start; an initially idle snapshot
    // does not prove execution finished. Wait for its durable terminal receipt.
    await expect(
      client.request("plan.execute", { sessionId: session.id, id: plan.id }),
    ).rejects.toThrow(/changed/);
    expect(
      await transport.request(
        "plan.execute",
        { sessionId: session.id, id: plan.id },
        false,
        { id: executed.id },
      ),
    ).toMatchObject({ duplicate: true, receipt: { status: "completed" } });
    const events = (await client.request("events.read", {
      sessionId: session.id,
    })) as { type: string }[];
    expect(events.filter((event) => event.type === "run.start")).toHaveLength(
      1,
    );
  } finally {
    client.close();
    await transport.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("discards delayed workflow reads after disconnection", async () => {
  const { AttachedWorkflows } =
    await import("../apps/cli/src/attached-workflows.ts");
  const response = deferred<unknown>();
  const request = vi.fn(() => response.promise);
  const client = {
    state: { canAct: true, session: { id: "session" } },
    request,
  } as unknown as ClientConnection;
  const view = {
    closeModelPanel: vi.fn(),
    notice: vi.fn(),
  } as unknown as import("../packages/tui/src/index.ts").HikaroView;
  const workflows = new AttachedWorkflows(client, view, "/tmp");
  try {
    const command = workflows.command("/plan", "");
    const rejected = expect(command).rejects.toThrow(/changed/);
    workflows.disconnected();
    response.resolve({ active: false });
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.notice).not.toHaveBeenCalled();
  } finally {
    workflows.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
