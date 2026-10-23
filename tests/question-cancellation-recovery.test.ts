import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../packages/runtime/src/index.ts";
import { RpcWorkflows } from "../apps/cli/src/rpc-workflows.ts";

const questions = [
  {
    id: "scope",
    question: "Choose recovery scope",
    options: ["Small", "Large"],
  },
];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-question-cancel-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  const session = await runtime.session(),
    other = await runtime.session();
  const agent = await runtime.agent(session);
  await runtime.setPlanning(session, true);
  await runtime.store.setSessionAccess(home, session.id, "device", "control");
  const workflows = new RpcWorkflows(runtime, "same-process", true);
  const abort = new AbortController();
  const answer = workflows.ask(questions, abort.signal, session.id, "device");
  await workflows.ready();
  const invoke = (
    method: string,
    p: Record<string, unknown> = {},
    scope = "device",
  ) => workflows.handle(method, p, session, agent, scope);
  const question = (await invoke("questions.read")) as {
    id: string;
    recovered: boolean;
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    home,
    runtime,
    session,
    other,
    agent,
    workflows,
    abort,
    answer,
    invoke,
    question,
    log,
    async close() {
      workflows.close();
      await runtime.close(() => workflows.ready());
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    },
  };
}

it("recovers failed cancellation in the same process with identity, role, lease and once-only checks", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.runtime.store, "settleQuestion").mockRejectedValueOnce(
      Error("Temporary cancellation failure"),
    );
    f.abort.abort();
    expect(await f.answer).toBeUndefined();
    expect(f.log).toHaveBeenCalledWith(
      expect.stringContaining("Temporary cancellation failure"),
    );
    expect(await f.invoke("questions.read")).toMatchObject({
      id: f.question.id,
      recovered: true,
    });
    expect(await f.invoke("questions.read", {}, "another-device")).toBeNull();
    const response = { id: f.question.id, answers: { scope: "Small" } };
    await expect(
      f.invoke("questions.respond", response, "another-device"),
    ).rejects.toThrow(/expired|identity/);
    await expect(
      f.workflows.handle(
        "questions.respond",
        response,
        f.other,
        await f.runtime.agent(f.other),
        "device",
      ),
    ).rejects.toThrow(/expired|identity/);
    const lease = await f.runtime.store.acquireLease(f.session.id, "new-run");
    await expect(f.invoke("questions.respond", response)).rejects.toThrow(
      /lease/,
    );
    await expect(
      f.invoke("questions.respond", { id: f.question.id, cancelled: true }),
    ).rejects.toThrow(/lease/);
    await f.runtime.store.releaseLease(f.session.id, lease!);
    await f.runtime.store.setSessionAccess(
      f.home,
      f.session.id,
      "device",
      "view",
    );
    await expect(f.invoke("questions.respond", response)).rejects.toThrow(
      /access denied/,
    );
    await f.runtime.store.setSessionAccess(
      f.home,
      f.session.id,
      "device",
      "control",
    );
    expect(
      (await f.runtime.store.pendingQuestions(f.session.id, "device"))[0]!
        .hostInstanceId,
    ).toBe("same-process");
    const outcomes = await Promise.allSettled([
      f.invoke("questions.respond", response),
      f.invoke("questions.respond", response),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: { completed: true, recovered: true } },
    ]);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const messages = await f.runtime.store.messages(f.session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("Small");
    const events = await f.runtime.store.events(f.session.id);
    expect(
      events.filter((e) => e.type === "question.response").map((e) => e.data),
    ).toMatchObject([{ recovered: true, cancelled: false }]);
    expect(events.filter((e) => e.type === "run.start")).toEqual([]);
    expect(await f.answer).toBeUndefined();
    expect(f.runtime.planning.get(f.session.id).active).toBe(true);
    expect(await f.invoke("questions.read")).toBeNull();
    await expect(f.invoke("questions.respond", response)).rejects.toThrow(
      /expired/,
    );
  } finally {
    await f.close();
  }
});

it("allows explicit dismissal after a failed cancellation without adding model context", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.runtime.store, "settleQuestion").mockRejectedValueOnce(
      Error("Temporary cancellation failure"),
    );
    f.abort.abort();
    await f.answer;
    expect(
      await f.invoke("questions.respond", {
        id: f.question.id,
        cancelled: true,
      }),
    ).toEqual({ completed: true, recovered: true });
    expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
    expect(
      (await f.runtime.store.events(f.session.id))
        .filter((e) => e.type === "question.response")
        .map((e) => e.data),
    ).toMatchObject([{ recovered: true, cancelled: true }]);
  } finally {
    await f.close();
  }
});

it("does not accept RPC recovery flags for live or unknown same-instance questions", async () => {
  const f = await fixture();
  try {
    expect(
      await f.invoke("questions.respond", {
        id: f.question.id,
        answers: { scope: "Small" },
        recover: true,
        interrupted: true,
      }),
    ).toEqual({ completed: true, recovered: false });
    expect(await f.answer).toEqual({ scope: "Small" });
    expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
    const id = randomUUID();
    await f.runtime.store.saveQuestion({
      id,
      sessionId: f.session.id,
      executionSessionId: f.session.id,
      scope: "device",
      hostInstanceId: "same-process",
      questions,
    });
    await expect(
      f.invoke("questions.respond", {
        id,
        answers: { scope: "Small" },
        recover: true,
        interrupted: true,
      }),
    ).rejects.toThrow(/expired/);
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, "device"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each(["pending", "failed"] as const)(
  "rejects a late live answer when cancellation is %s, then requires an explicit recovered answer",
  async (state) => {
    const f = await fixture();
    let releaseRead!: () => void, failCancel!: (error: Error) => void;
    try {
      let readStarted!: () => void, cancelStarted!: () => void;
      const reading = new Promise<void>((done) => {
        readStarted = done;
      });
      const cancelling = new Promise<void>((done) => {
        cancelStarted = done;
      });
      const readGate = new Promise<void>((done) => {
        releaseRead = done;
      });
      const cancelGate = new Promise<never>((_, reject) => {
        failCancel = reject;
      });
      const original = f.runtime.store.pendingQuestions.bind(f.runtime.store);
      vi.spyOn(f.runtime.store, "pendingQuestions").mockImplementationOnce(
        async (...args) => {
          const result = await original(...args);
          readStarted();
          await readGate;
          return result;
        },
      );
      vi.spyOn(f.runtime.store, "settleQuestion").mockImplementationOnce(() => {
        cancelStarted();
        return cancelGate;
      });
      const response = { id: f.question.id, answers: { scope: "Small" } };
      const late = f.invoke("questions.respond", response);
      const rejected = expect(late).rejects.toThrow(/cancel/i);
      await reading;
      f.abort.abort();
      await cancelling;
      if (state === "failed") {
        failCancel(Error("Temporary cancellation failure"));
        expect(await f.answer).toBeUndefined();
      }
      releaseRead();
      await rejected;
      expect(
        await f.runtime.store.pendingQuestions(f.session.id, "device"),
      ).toHaveLength(1);
      expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
      if (state === "pending")
        failCancel(Error("Temporary cancellation failure"));
      expect(await f.answer).toBeUndefined();
      expect(await f.invoke("questions.respond", response)).toEqual({
        completed: true,
        recovered: true,
      });
      expect(await f.runtime.store.messages(f.session.id)).toHaveLength(1);
    } finally {
      releaseRead?.();
      failCancel?.(Error("Test cleanup"));
      await f.answer;
      await f.close();
    }
  },
);

it("does not reveal another identity's cancellation state to a delayed response", async () => {
  const f = await fixture();
  let releaseRead!: () => void, failCancel!: (error: Error) => void;
  try {
    let readStarted!: () => void, cancelStarted!: () => void;
    const reading = new Promise<void>((done) => {
      readStarted = done;
    });
    const cancelling = new Promise<void>((done) => {
      cancelStarted = done;
    });
    const readGate = new Promise<void>((done) => {
      releaseRead = done;
    });
    const cancelGate = new Promise<never>((_, reject) => {
      failCancel = reject;
    });
    const original = f.runtime.store.pendingQuestions.bind(f.runtime.store);
    vi.spyOn(f.runtime.store, "pendingQuestions").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        readStarted();
        await readGate;
        return result;
      },
    );
    vi.spyOn(f.runtime.store, "settleQuestion").mockImplementationOnce(() => {
      cancelStarted();
      return cancelGate;
    });
    const response = f.invoke(
      "questions.respond",
      { id: f.question.id, answers: { scope: "Small" } },
      "another-device",
    );
    const rejected = expect(response).rejects.toThrow(/expired|identity/);
    await reading;
    f.abort.abort();
    await cancelling;
    releaseRead();
    await rejected;
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, "device"),
    ).toHaveLength(1);
  } finally {
    releaseRead?.();
    failCancel?.(Error("Test cleanup"));
    await f.answer;
    await f.close();
  }
});
