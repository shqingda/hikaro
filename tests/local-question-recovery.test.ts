import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Runtime } from "../packages/runtime/src/index.ts";
import {
  LocalQuestions,
  localQuestionScope,
} from "../apps/cli/src/local-questions.ts";
import { RpcWorkflows } from "../apps/cli/src/rpc-workflows.ts";
import { QuestionService } from "../apps/cli/src/question-service.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

function ui() {
  let panel: ModelPanel | undefined;
  let controller: AbortController;
  const notice = vi.fn();
  const view = {
    notice,
    setError: vi.fn(),
    openModelPanel() {
      const current = new AbortController();
      controller = current;
      const currentPanel = new ModelPanel(current.signal, () => {});
      panel = currentPanel;
      return {
        panel: currentPanel,
        signal: current.signal,
        close: () => {
          current.abort();
          if (panel === currentPanel) panel = undefined;
        },
      };
    },
  } as unknown as HikaroView;
  return {
    view,
    notice,
    abort: () => controller?.abort(),
    input: (text: string) => panel!.handleInput(text),
    wait: (text: string) =>
      vi.waitFor(() =>
        expect(
          stripVTControlCharacters(panel?.render(110).join("\n") ?? ""),
        ).toContain(text),
      ),
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-local-questions-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  const session = await runtime.session();
  const f = ui();
  const local = new LocalQuestions(runtime, () => f.view);
  await local.select(session.id);
  return {
    ...f,
    home,
    runtime,
    session,
    local,
    async close() {
      local.close();
      await runtime.close(() => local.ready());
      await rm(home, { recursive: true, force: true });
    },
  };
}
const questions = [
  {
    id: "scope",
    question: "Choose recovery scope",
    options: ["Small", "Large"],
  },
];

it("flushes unsubmitted answer input before a normal close without settling the question", async () => {
  const f = await fixture();
  try {
    const answer = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    f.input("\x1b[B");
    f.input("\x1b[B");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Your answer");
    f.input("still typing 中文🌅");
    f.local.close();
    await f.local.ready();
    expect(await answer).toBeUndefined();
    const [question] = await f.runtime.store.pendingQuestions(
      f.session.id,
      localQuestionScope,
    );
    expect(question).toBeDefined();
    expect(
      await f.runtime.store.questionDraft({
        id: question!.id,
        sessionId: f.session.id,
        scope: localQuestionScope,
      }),
    ).toMatchObject({
      draft: {
        answers: {},
        inputs: { scope: "still typing 中文🌅" },
        position: { kind: "input", questionId: "scope" },
      },
    });
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("drains the newest input on close while an older draft write is still pending", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const original = f.runtime.store.saveQuestionDraft.bind(f.runtime.store);
  const saving = vi
    .spyOn(f.runtime.store, "saveQuestionDraft")
    .mockImplementationOnce(async (input) => {
      await gate;
      return original(input);
    });
  try {
    const answer = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    f.input("\x1b[B");
    f.input("\x1b[B");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Your answer");
    f.input("older");
    await vi.waitFor(() => expect(saving).toHaveBeenCalledTimes(1));
    f.input(" plus latest 中文🌅");
    f.local.close();
    expect(await answer).toBeUndefined();
    release();
    await f.local.ready();
    const [question] = await f.runtime.store.pendingQuestions(
      f.session.id,
      localQuestionScope,
    );
    expect(
      await f.runtime.store.questionDraft({
        id: question!.id,
        sessionId: f.session.id,
        scope: localQuestionScope,
      }),
    ).toMatchObject({
      revision: 2,
      draft: { inputs: { scope: "older plus latest 中文🌅" } },
    });
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
  } finally {
    release();
    saving.mockRestore();
    await f.close();
  }
});

it("reopens a cancelled question after its cancellation write fails without reconnecting the old waiter", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.runtime.setPlanning(f.session, true);
    const abort = new AbortController();
    const answer = f.local.ask(questions, abort.signal, f.session.id);
    await f.wait("Question 1/1");
    vi.spyOn(f.runtime.store, "settleQuestion").mockRejectedValueOnce(
      Error("Temporary cancellation failure"),
    );
    abort.abort();
    expect(await answer).toBeUndefined();
    const opened = f.local.open();
    await f.wait("Recovered question 1/1");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await opened;
    expect(await answer).toBeUndefined();
    expect((await f.runtime.store.messages(f.session.id))[0]!.text).toContain(
      "Small",
    );
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "run.start",
      ),
    ).toEqual([]);
    expect(f.runtime.planning.get(f.session.id).active).toBe(true);
  } finally {
    log.mockRestore();
    await f.close();
  }
});

it("keeps a live answer available after a failed save and resumes only after explicit retry", async () => {
  const f = await fixture();
  try {
    const answer = f.local
      .ask(questions, new AbortController().signal, f.session.id)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await f.wait("Question 1/1");
    const failure = vi
      .spyOn(f.runtime.store, "settleQuestion")
      .mockRejectedValueOnce(Error("Temporary storage failure"));
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Answers not saved");
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    f.input("\x1b[B");
    f.input("\r");
    expect(await answer).toEqual({ value: { scope: "Small" } });
    expect(failure).toHaveBeenCalledTimes(2);
    expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("leaves a question answerable in the same process when another panel prevents initial display", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.view, "openModelPanel").mockImplementationOnce(() => {
      throw Error("Model picker is already open");
    });
    const answer = f.local
      .ask(questions, new AbortController().signal, f.session.id)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await vi.waitFor(() =>
      expect(f.notice).toHaveBeenCalledWith(
        expect.stringContaining("/questions"),
      ),
    );
    const opened = f.local.open();
    await f.wait("Question 1/1");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await opened;
    expect(await answer).toEqual({ value: { scope: "Small" } });
  } finally {
    await f.close();
  }
});

it("leaves failed live answers pending when the retry panel closes", async () => {
  const f = await fixture();
  try {
    const answer = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    vi.spyOn(f.runtime.store, "settleQuestion").mockRejectedValueOnce(
      Error("Temporary storage failure"),
    );
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Answers not saved");
    f.abort();
    await f.local.ready();
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    // Leaving the failed-save panel did not infer an answer or cancellation.
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
    const opened = f.local.open();
    await f.wait("Review answers");
    await f.wait("Small");
    expect(f.notice).toHaveBeenCalledWith(
      expect.stringContaining("Saved answer draft restored"),
    );
    f.abort();
    await opened;
    expect(await answer).toBeUndefined();
  } finally {
    await f.close();
  }
});

it.each(["selection", "close"] as const)(
  "rejects a response invalidated by %s while its pending record is being read",
  async (reason) => {
    const f = await fixture();
    const service = new QuestionService(f.runtime);
    let release!: () => void;
    try {
      const pending = service.ask(
        questions,
        new AbortController().signal,
        f.session.id,
        localQuestionScope,
      );
      const question = (await service.read(f.session.id, localQuestionScope))!;
      let read!: () => void;
      const started = new Promise<void>((done) => {
        read = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const original = f.runtime.store.pendingQuestions.bind(f.runtime.store);
      vi.spyOn(f.runtime.store, "pendingQuestions").mockImplementationOnce(
        async (...args) => {
          const result = await original(...args);
          read();
          await gate;
          return result;
        },
      );
      const signal = new AbortController();
      const response = service.respond(
        f.session.id,
        localQuestionScope,
        { id: question.id, answers: { scope: "Small" } },
        signal.signal,
      );
      const rejected = expect(response).rejects.toThrow(
        reason === "selection" ? /abort/i : /closing/,
      );
      await started;
      if (reason === "selection") signal.abort();
      else service.close();
      release();
      await rejected;
      expect(
        await f.runtime.store.pendingQuestions(
          f.session.id,
          localQuestionScope,
        ),
      ).toHaveLength(1);
      expect(
        (await f.runtime.store.events(f.session.id)).filter(
          (e) => e.type === "question.response",
        ),
      ).toEqual([]);
      service.close();
      await pending;
    } finally {
      release?.();
      service.close();
      await f.close();
    }
  },
);

it("invalidates a delayed question read before a new session starts binding", async () => {
  const f = await fixture();
  let restored: LocalQuestions | undefined;
  let release!: () => void;
  try {
    const pending = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    f.local.close();
    await pending;
    restored = new LocalQuestions(f.runtime, () => f.view);
    await restored.select(f.session.id);
    const display = vi.spyOn(f.view, "openModelPanel");
    let read!: () => void;
    const started = new Promise<void>((done) => {
      read = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = f.runtime.store.pendingQuestions.bind(f.runtime.store);
    vi.spyOn(f.runtime.store, "pendingQuestions").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        read();
        await gate;
        return result;
      },
    );
    const opening = restored.open();
    await started;
    // bind must do this synchronously, before its first draft/history/agent await.
    restored.invalidate();
    release();
    await opening;
    expect(display).not.toHaveBeenCalled();
    const other = await f.runtime.session();
    await restored.select(other.id);
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    expect(await f.runtime.store.messages(other.id)).toEqual([]);
  } finally {
    release?.();
    restored?.close();
    await f.close();
  }
});

it("persists before display, preserves on exit, and recovers once without starting a run", async () => {
  const f = await fixture();
  let restored: LocalQuestions | undefined;
  try {
    await f.runtime.setPlanning(f.session, true);
    const answer = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    f.local.close();
    f.abort();
    expect(await answer).toBeUndefined();
    await f.local.ready();
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toEqual([]);
    restored = new LocalQuestions(f.runtime, () => f.view);
    await restored.select(f.session.id);
    expect(f.notice).toHaveBeenCalledWith(
      expect.stringContaining("/questions"),
    );
    const open = restored.open();
    await f.wait("Recovered question 1/1");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await open;
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toEqual([]);
    const messages = await f.runtime.store.messages(f.session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("Small");
    expect(f.runtime.planning.get(f.session.id).active).toBe(true);
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "run.start",
      ),
    ).toEqual([]);
    await restored.open();
    expect(await f.runtime.store.messages(f.session.id)).toHaveLength(1);
  } finally {
    restored?.close();
    await f.close();
  }
});

it("keeps scopes separate and preserves pending questions when selection invalidates a panel", async () => {
  const f = await fixture();
  const host = new RpcWorkflows(f.runtime, "host");
  try {
    const pending = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    const agent = await f.runtime.agent(f.session);
    expect(
      await host.handle("questions.read", {}, f.session, agent, "default"),
    ).toBeNull();
    expect(
      await host.handle(
        "questions.read",
        {},
        f.session,
        agent,
        "local:standalone:tui",
      ),
    ).toBeNull();
    const other = await f.runtime.session();
    await f.local.select(other.id);
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    expect(await f.runtime.store.messages(other.id)).toEqual([]);
    await f.local.select(f.session.id);
    const opened = f.local.open();
    await f.wait("Question 1/1");
    f.abort(); // Explicit panel cancellation settles this live question.
    await opened;
    expect(await pending).toBeUndefined();
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toEqual([]);
    expect(
      (await f.runtime.store.events(f.session.id)).filter(
        (e) => e.type === "question.response",
      ),
    ).toHaveLength(1);
  } finally {
    host.close();
    await f.close();
  }
});

it("retains recovered answers across a lease rejection until explicit retry", async () => {
  const f = await fixture();
  let restored: LocalQuestions | undefined;
  try {
    const pending = f.local.ask(
      questions,
      new AbortController().signal,
      f.session.id,
    );
    await f.wait("Question 1/1");
    f.local.close();
    await pending;
    restored = new LocalQuestions(f.runtime, () => f.view);
    await restored.select(f.session.id);
    const lease = await f.runtime.store.acquireLease(
      f.session.id,
      "active-owner",
    );
    const work = restored.open();
    await f.wait("Recovered question 1/1");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Review answers");
    f.input("\x1b[B");
    f.input("\r");
    await f.wait("Answers not saved");
    expect(
      await f.runtime.store.pendingQuestions(f.session.id, localQuestionScope),
    ).toHaveLength(1);
    expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
    await f.runtime.store.releaseLease(f.session.id, lease!);
    f.input("\x1b[B");
    f.input("\r");
    await work;
    expect((await f.runtime.store.messages(f.session.id))[0]!.text).toContain(
      "Small",
    );
  } finally {
    restored?.close();
    await f.close();
  }
});
