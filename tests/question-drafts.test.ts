import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { QuestionService } from "../apps/cli/src/question-service.ts";
import { RpcWorkflows } from "../apps/cli/src/rpc-workflows.ts";
import { serveRpc } from "../apps/cli/src/rpc.ts";
import { isMutation } from "../apps/cli/src/rpc-receipts.ts";
import { isControlMethod, JsonLines } from "../packages/protocol/src/index.ts";
import {
  rpcCapabilities,
  rpcReadMethods,
  rpcTransientMethods,
} from "../packages/protocol/src/contracts.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});
const draft = {
  answers: { choice: "Small" },
  inputs: { detail: "Unsubmitted text 中文" },
  position: { kind: "input" as const, questionId: "detail" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-question-draft-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  const session = await runtime.session();
  await runtime.store.setSessionAccess(home, session.id, "device", "control");
  const service = new QuestionService(runtime, "first", true);
  const answer = service.ask(
    [
      { id: "choice", question: "Which size?", options: ["Small", "Large"] },
      { id: "detail", question: "Add details" },
    ],
    new AbortController().signal,
    session.id,
    "device",
  );
  await service.ready();
  const question = (await service.read(session.id, "device"))!;
  const identity = {
    id: question.id,
    sessionId: session.id,
    scope: "device",
    workspace: home,
  };
  const db = new DatabaseSync(join(home, "sessions.sqlite"));
  cleanups.push(async () => {
    service.close();
    await runtime.close(() => service.ready());
    db.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, runtime, session, service, answer, question, identity, db };
}

it("restores partial answers and unsubmitted input without settling or resuming a question", async () => {
  const f = await fixture();
  expect(
    await f.service.readDraft(f.session.id, "device", { id: f.question.id }),
  ).toEqual({ revision: 0, draft: null });
  expect(
    await f.service.saveDraft(f.session.id, "device", {
      id: f.question.id,
      expectedRevision: 0,
      draft,
    }),
  ).toEqual({ revision: 1 });
  f.service.close();
  expect(await f.answer).toBeUndefined();
  const restored = new QuestionService(f.runtime, "second", true);
  expect(
    await restored.readDraft(f.session.id, "device", { id: f.question.id }),
  ).toEqual({ revision: 1, draft });
  expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
  expect(
    (await f.runtime.store.events(f.session.id)).filter((e) =>
      ["run.start", "question.response"].includes(e.type),
    ),
  ).toEqual([]);
  restored.close();
});

it("uses an atomic revision across connections and never replaces a newer draft", async () => {
  const f = await fixture();
  const second = await SQLiteStore.open(join(f.home, "sessions.sqlite"));
  try {
    const saves = await Promise.all([
      f.runtime.store.saveQuestionDraft({
        ...f.identity,
        expectedRevision: 0,
        draft,
      }),
      second.saveQuestionDraft({
        ...f.identity,
        expectedRevision: 0,
        draft: { ...draft, inputs: { detail: "Other editor" } },
      }),
    ]);
    expect(saves.filter((result) => "revision" in result)).toEqual([
      { revision: 1 },
    ]);
    const current = await second.questionDraft(f.identity);
    expect(saves.filter((result) => "conflict" in result)).toEqual([
      { conflict: true, current },
    ]);
    expect(
      await f.runtime.store.saveQuestionDraft({
        ...f.identity,
        expectedRevision: 0,
        draft,
      }),
    ).toEqual({ conflict: true, current });
    expect(await second.questionDraft(f.identity)).toEqual(current);
  } finally {
    await second.close();
  }
});

it("allows editing under a live lease but rejects stale settlement and atomically removes the draft", async () => {
  const f = await fixture();
  const lease = await f.runtime.store.acquireLease(f.session.id, "execution");
  expect(
    await f.service.saveDraft(f.session.id, "device", {
      id: f.question.id,
      expectedRevision: 0,
      draft,
    }),
  ).toEqual({ revision: 1 });
  f.service.close();
  const recovered = new QuestionService(f.runtime, "second", true);
  const answers = { choice: "Small", detail: "Final text" };
  await expect(
    recovered.respond(f.session.id, "device", {
      id: f.question.id,
      answers,
      draftRevision: 1,
    }),
  ).rejects.toThrow(/lease/);
  await f.runtime.store.releaseLease(f.session.id, lease!);
  await expect(
    recovered.respond(f.session.id, "device", {
      id: f.question.id,
      answers,
      draftRevision: 0,
    }),
  ).rejects.toThrow(/draft.*changed|revision/i);
  expect(
    await recovered.readDraft(f.session.id, "device", { id: f.question.id }),
  ).toEqual({ revision: 1, draft });
  expect(
    await recovered.respond(f.session.id, "device", {
      id: f.question.id,
      answers,
      draftRevision: 1,
    }),
  ).toEqual({ completed: true, recovered: true });
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM question_drafts").get()!.count,
  ).toBe(0);
  await expect(
    f.runtime.store.saveQuestionDraft({
      ...f.identity,
      expectedRevision: 0,
      draft,
    }),
  ).rejects.toThrow(/expired|identity/);
  expect(await f.runtime.store.messages(f.session.id)).toHaveLength(1);
  recovered.close();
});

it("cleans drafts on explicit cancellation and session deletion while old clients remain compatible", async () => {
  const f = await fixture();
  await f.runtime.store.saveQuestionDraft({
    ...f.identity,
    expectedRevision: 0,
    draft,
  });
  await f.service.respond(f.session.id, "device", {
    id: f.question.id,
    cancelled: true,
  });
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM question_drafts").get()!.count,
  ).toBe(0);
  expect(await f.runtime.store.messages(f.session.id)).toEqual([]);
  void f.service.ask(
    [{ id: "detail", question: "More?" }],
    new AbortController().signal,
    f.session.id,
    "device",
  );
  await f.service.ready();
  const q = (await f.service.read(f.session.id, "device"))!;
  await f.runtime.store.saveQuestionDraft({
    ...f.identity,
    id: q.id,
    expectedRevision: 0,
    draft: {
      answers: {},
      inputs: { detail: "keep" },
      position: { kind: "input", questionId: "detail" },
    },
  });
  await f.runtime.store.deleteSession(f.session.id);
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM question_drafts").get()!.count,
  ).toBe(0);
});

it("checks question identity, current control rights, and workspace for reads and writes", async () => {
  const f = await fixture();
  await f.runtime.store.saveQuestionDraft({
    ...f.identity,
    expectedRevision: 0,
    draft,
  });
  const other = await f.runtime.session();
  for (const invalid of [
    { ...f.identity, scope: "other" },
    { ...f.identity, sessionId: other.id },
    { ...f.identity, workspace: "/wrong" },
  ]) {
    await expect(f.runtime.store.questionDraft(invalid)).rejects.toThrow(
      /expired|identity|access/,
    );
    await expect(
      f.runtime.store.saveQuestionDraft({
        ...invalid,
        expectedRevision: 1,
        draft,
      }),
    ).rejects.toThrow(/expired|identity|access/);
  }
  await f.runtime.store.setSessionAccess(
    f.home,
    f.session.id,
    "device",
    "view",
  );
  await expect(
    f.service.readDraft(f.session.id, "device", { id: f.question.id }),
  ).rejects.toThrow(/access/);
  await expect(
    f.service.saveDraft(f.session.id, "device", {
      id: f.question.id,
      expectedRevision: 1,
      draft,
    }),
  ).rejects.toThrow(/access/);
});

it("rejects unknown answer keys, invalid positions, oversized UTF-8 payloads and unsafe revisions", async () => {
  const f = await fixture();
  for (const invalid of [
    { ...draft, answers: { unknown: "value" } },
    { ...draft, inputs: { unknown: "value" } },
    { ...draft, position: { kind: "input", questionId: "missing" } },
    { ...draft, position: { kind: "review" } },
    { ...draft, inputs: { detail: "x".repeat(100001) } },
    {
      ...draft,
      answers: { choice: "中".repeat(100000) },
      inputs: { detail: "中".repeat(100000) },
    },
  ])
    await expect(
      f.runtime.store.saveQuestionDraft({
        ...f.identity,
        expectedRevision: 0,
        draft: invalid as typeof draft,
      }),
    ).rejects.toThrow(/draft/i);
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity])
    await expect(
      f.runtime.store.saveQuestionDraft({
        ...f.identity,
        expectedRevision,
        draft,
      }),
    ).rejects.toThrow(/revision/i);
  expect(await f.runtime.store.questionDraft(f.identity)).toEqual({
    revision: 0,
    draft: null,
  });
});

it("advertises responsive draft methods without task receipts or view-role write permission", async () => {
  expect(rpcCapabilities().methods).toContain("questions.draft.read");
  expect(rpcCapabilities().methods).toContain("questions.draft.save");
  expect(isControlMethod("questions.draft.read")).toBe(true);
  expect(isControlMethod("questions.draft.save")).toBe(true);
  expect(rpcReadMethods.has("questions.draft.save")).toBe(false);
  expect(rpcTransientMethods.has("questions.draft.save")).toBe(true);
  expect(isMutation("questions.draft.save")).toBe(false);
  const f = await fixture();
  const workflows = new RpcWorkflows(f.runtime, "second", true);
  const agent = await f.runtime.agent(f.session);
  expect(
    await workflows.handle(
      "questions.draft.save",
      { id: f.question.id, expectedRevision: 0, draft },
      f.session,
      agent,
      "device",
    ),
  ).toEqual({ revision: 1 });
  expect(
    await workflows.handle(
      "questions.draft.read",
      { id: f.question.id },
      f.session,
      agent,
      "device",
    ),
  ).toEqual({ revision: 1, draft });
  workflows.close();
});

it("rolls back settlement cleanup and preserves the last saved draft after a storage failure", async () => {
  const f = await fixture();
  await f.runtime.store.saveQuestionDraft({
    ...f.identity,
    expectedRevision: 0,
    draft,
  });
  f.db.exec(
    "CREATE TRIGGER fail_question_settle BEFORE INSERT ON events WHEN NEW.type='question.response' BEGIN SELECT RAISE(ABORT,'Injected settlement failure'); END",
  );
  await expect(
    f.service.respond(f.session.id, "device", {
      id: f.question.id,
      cancelled: true,
      draftRevision: 1,
    }),
  ).rejects.toThrow(/Injected/);
  expect(await f.runtime.store.questionDraft(f.identity)).toEqual({
    revision: 1,
    draft,
  });
  expect(
    await f.runtime.store.pendingQuestions(f.session.id, "device"),
  ).toHaveLength(1);
  f.db.exec("DROP TRIGGER fail_question_settle");
  await f.service.respond(f.session.id, "device", {
    id: f.question.id,
    cancelled: true,
    draftRevision: 1,
  });
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM question_drafts").get()!.count,
  ).toBe(0);
});

it("discards delayed reads after abort or close and drains saves admitted before close", async () => {
  const f = await fixture();
  const storedRead = f.runtime.store.questionDraft.bind(f.runtime.store);
  const gate = deferred<void>(),
    entered = deferred<void>();
  vi.spyOn(f.runtime.store, "questionDraft").mockImplementationOnce(
    async (input) => {
      const result = await storedRead(input);
      entered.resolve();
      await gate.promise;
      return result;
    },
  );
  const abort = new AbortController();
  const read = f.service.readDraft(
    f.session.id,
    "device",
    { id: f.question.id },
    abort.signal,
  );
  const rejectedRead = expect(read).rejects.toThrow(/abort/i);
  await entered.promise;
  abort.abort();
  gate.resolve();
  await rejectedRead;

  const saved = f.service.saveDraft(f.session.id, "device", {
    id: f.question.id,
    expectedRevision: 0,
    draft,
  });
  f.service.close();
  await f.service.ready();
  expect(await saved).toEqual({ revision: 1 });
  expect(await storedRead(f.identity)).toEqual({ revision: 1, draft });
  await expect(
    f.service.saveDraft(f.session.id, "device", {
      id: f.question.id,
      expectedRevision: 1,
      draft,
    }),
  ).rejects.toThrow(/closing/);
  await expect(
    f.service.readDraft(f.session.id, "device", { id: f.question.id }),
  ).rejects.toThrow(/closing/);
});

it("serves drafts while a normal RPC request waits and creates no durable action receipt", async () => {
  const f = await fixture();
  const input = new PassThrough(),
    output = new PassThrough();
  const pending = new Map<string, (value: any) => void>();
  const parser = new JsonLines((frame: any) => {
    if (frame.type !== "response") return;
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });
  output.on("data", (chunk) => parser.push(chunk));
  const server = await serveRpc(
    { cwd: f.home, home: f.home, demo: true },
    { input, output, error: new PassThrough() },
  );
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = `draft-${++sequence}`;
    const result = new Promise<any>((resolve) => pending.set(id, resolve));
    input.write(JSON.stringify({ id, scope: "device", method, params }) + "\n");
    return { id, result };
  };
  const gate = deferred<void>(),
    entered = deferred<void>();
  try {
    expect(
      (await request("session.resume", { sessionId: f.session.id }).result)
        .error,
    ).toBeUndefined();
    const sessions = SQLiteStore.prototype.sessions;
    vi.spyOn(SQLiteStore.prototype, "sessions").mockImplementationOnce(
      async function (this: SQLiteStore, ...args) {
        entered.resolve();
        await gate.promise;
        return sessions.apply(this, args);
      },
    );
    const blocked = request("session.list");
    await entered.promise;
    const save = request("questions.draft.save", {
      id: f.question.id,
      sessionId: f.session.id,
      expectedRevision: 0,
      draft,
    });
    expect((await save.result).result).toEqual({ revision: 1 });
    expect(
      (
        await request("questions.draft.read", {
          id: f.question.id,
          sessionId: f.session.id,
        }).result
      ).result,
    ).toEqual({ revision: 1, draft });
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS count FROM rpc_commands WHERE id=?")
        .get(save.id)!.count,
    ).toBe(0);
    gate.resolve();
    expect((await blocked.result).error).toBeUndefined();
  } finally {
    gate.resolve();
    await server.close();
  }
});

it("permits trusted phone question drafts and answers without a per-session grant", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-phone-question-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  const session = await runtime.session();
  const service = new QuestionService(runtime, "phone-default", true, true);
  const response = service.ask(
    [{ id: "choice", question: "Continue?", options: ["Yes", "No"] }],
    new AbortController().signal,
    session.id,
    "device",
  );
  cleanups.push(async () => {
    service.close();
    await runtime.close(() => service.ready());
    await rm(home, { recursive: true, force: true });
  });
  await service.ready();
  const question = (await service.read(session.id, "device"))!;
  await service.saveDraft(session.id, "device", {
    id: question.id,
    expectedRevision: 0,
    draft: {
      answers: { choice: "Yes" },
      inputs: {},
      position: { kind: "review" },
    },
  });
  expect(
    await service.readDraft(session.id, "device", { id: question.id }),
  ).toMatchObject({ revision: 1 });
  await service.respond(session.id, "device", {
    id: question.id,
    answers: { choice: "Yes" },
    draftRevision: 1,
  });
  expect(await response).toEqual({ choice: "Yes" });
});
