import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import { RpcWorkflows } from "../packages/cli/src/rpc-workflows.ts";

it("restores unanswered questions by identity and saves answers once without executing", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-question-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  try {
    const session = await runtime.session();
    const agent = await runtime.agent(session);
    await runtime.setPlanning(session, true);
    const original = new RpcWorkflows(runtime, "old-host");
    void original.ask(
      [{ id: "choice", question: "Which scope?", options: ["Small", "Large"] }],
      new AbortController().signal,
      session.id,
      "local:owner",
    );
    await original.ready();
    const restored = new RpcWorkflows(runtime, "new-host");
    const invoke = (method: string, params = {}, scope = "local:owner") =>
      restored.handle(method, params, session, agent, scope);
    expect(await invoke("questions.read", {}, "local:other")).toBeNull();
    const question = (await invoke("questions.read")) as {
      id: string;
      recovered: boolean;
    };
    expect(question.recovered).toBe(true);
    await expect(
      invoke(
        "questions.respond",
        { id: question.id, answers: { choice: "Small" } },
        "local:other",
      ),
    ).rejects.toThrow(/expired|identity/);
    const lease = await runtime.store.acquireLease(session.id, "another-owner");
    await expect(
      invoke("questions.respond", {
        id: question.id,
        answers: { choice: "Small" },
      }),
    ).rejects.toThrow(/lease|running/);
    await runtime.store.releaseLease(session.id, lease!);
    expect(
      await invoke("questions.respond", {
        id: question.id,
        answers: { choice: "Small" },
      }),
    ).toEqual({ completed: true, recovered: true });
    expect(await invoke("questions.read")).toBeNull();
    await expect(
      invoke("questions.respond", {
        id: question.id,
        answers: { choice: "Large" },
      }),
    ).rejects.toThrow(/expired/);
    const messages = await runtime.store.messages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("Which scope?");
    expect(messages[0]!.text).toContain("Small");
    expect(runtime.planning.get(session.id).active).toBe(true);
    expect(agent.snapshot().busy).toBe(false);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("rechecks current remote control rights, preserves questions on close and persists dismissal", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-question-access-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  try {
    const session = await runtime.session(),
      other = await runtime.session();
    const agent = await runtime.agent(session);
    const original = new RpcWorkflows(runtime, "old-host", true);
    const pending = original.ask(
      [{ id: "q", question: "Confirm scope" }],
      new AbortController().signal,
      session.id,
      "device",
    );
    await original.ready();
    original.close();
    expect(await pending).toBeUndefined();
    const restored = new RpcWorkflows(runtime, "new-host", true);
    const q = (await restored.handle(
      "questions.read",
      {},
      session,
      agent,
      "device",
    )) as { id: string };
    await expect(
      restored.handle(
        "questions.respond",
        { id: q.id, answers: { q: "yes" } },
        other,
        await runtime.agent(other),
        "device",
      ),
    ).rejects.toThrow(/expired/);
    await runtime.store.setSessionAccess(
      runtime.options.cwd,
      session.id,
      "device",
      "view",
    );
    await expect(
      restored.handle(
        "questions.respond",
        { id: q.id, answers: { q: "yes" } },
        session,
        agent,
        "device",
      ),
    ).rejects.toThrow(/access denied/);
    expect(
      await runtime.store.pendingQuestions(session.id, "device"),
    ).toHaveLength(1);
    await runtime.store.setSessionAccess(
      runtime.options.cwd,
      session.id,
      "device",
      "control",
    );
    await restored.handle(
      "questions.respond",
      { id: q.id, cancelled: true },
      session,
      agent,
      "device",
    );
    expect(await runtime.store.pendingQuestions(session.id, "device")).toEqual(
      [],
    );
    expect(await runtime.store.messages(session.id)).toEqual([]);
    const events = await runtime.store.events(session.id);
    expect(
      events
        .filter((e) => e.type === "question.response")
        .map((e) => e.data.cancelled),
    ).toEqual([true]);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
