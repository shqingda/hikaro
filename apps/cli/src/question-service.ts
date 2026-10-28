import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Questions } from "../../../packages/runtime/src/planning.ts";
import type { PendingQuestion } from "../../../packages/runtime/src/pending-questions.ts";
const draftRevisionSchema = z.number().int().nonnegative().safe();
const draftSchema = z.strictObject({
  answers: z.record(z.string().min(1).max(80), z.string().min(1).max(100000)),
  inputs: z.record(z.string().min(1).max(80), z.string().max(100000)),
  position: z.union([
    z.strictObject({
      kind: z.enum(["question", "input"]),
      questionId: z.string().min(1).max(80),
    }),
    z.strictObject({ kind: z.literal("review") }),
  ]),
});
export type QuestionView = {
  id: string;
  questions: Questions;
  recovered: boolean;
};
/** Shared durable question lifecycle for RPC and the ordinary terminal. */
export class QuestionService {
  private questions = new Map<
    string,
    {
      id: string;
      sessionId: string;
      questions: Questions;
      cancelling?: boolean;
      finish: (answers: Record<string, string> | undefined) => void;
    }
  >();
  private interrupted = new Map<
    string,
    {
      sessionId: string;
      executionSessionId: string;
      scope: string;
    }
  >();
  private writes = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private runtime: Runtime,
    private hostInstanceId: string = randomUUID(),
    private enforceAccess = false,
    private defaultDeviceControl = false,
  ) {}
  async ready() {
    while (this.writes.size) await Promise.all([...this.writes]);
  }
  private writing<T>(work: Promise<T>) {
    this.writes.add(work);
    void work.finally(() => this.writes.delete(work)).catch(() => {});
    return work;
  }
  private isInterrupted(question: PendingQuestion) {
    const interrupted = this.interrupted.get(question.id);
    return (
      question.hostInstanceId === this.hostInstanceId &&
      interrupted?.sessionId === question.sessionId &&
      interrupted?.executionSessionId === question.executionSessionId &&
      interrupted?.scope === question.scope
    );
  }
  ask(
    questions: Questions,
    signal: AbortSignal,
    executionSessionId: string,
    scope = "default",
    present?: (question: QuestionView) => Promise<void>,
  ): Promise<Record<string, string> | undefined> {
    signal.throwIfAborted();
    if (this.closing) throw Error("Questions are closing");
    const id = randomUUID();
    const sessionId = this.runtime.approvalAuthority(executionSessionId);
    const saved = this.writing(
      this.runtime.store.saveQuestion({
        id,
        sessionId,
        executionSessionId,
        scope,
        hostInstanceId: this.hostInstanceId,
        questions,
      }),
    );
    return new Promise((resolve, reject) => {
      const finish = (answers: Record<string, string> | undefined) => {
        signal.removeEventListener("abort", abort);
        this.questions.delete(id);
        resolve(answers);
      };
      const abort = () => {
        if (this.closing) return finish(undefined);
        const pending = this.questions.get(id);
        if (pending) pending.cancelling = true;
        let persisted = false;
        void this.writing(
          saved.then(() => {
            persisted = true;
            return this.runtime.store.settleQuestion({
              id,
              sessionId,
              scope,
              hostInstanceId: this.hostInstanceId,
            });
          }),
        ).then(
          () => finish(undefined),
          (error) => {
            if (persisted && !this.closing)
              this.interrupted.set(id, {
                sessionId,
                executionSessionId,
                scope,
              });
            finish(undefined);
            console.error(
              `Question cancellation could not be saved: ${String(error)}`,
            );
          },
        );
      };
      this.questions.set(id, { id, sessionId, questions, finish });
      signal.addEventListener("abort", abort, { once: true });
      void saved
        .then(async () => {
          if (!this.closing && !signal.aborted)
            await present?.({ id, questions, recovered: false });
        })
        .catch((error) => {
          signal.removeEventListener("abort", abort);
          this.questions.delete(id);
          reject(error);
        });
    });
  }
  async read(sessionId: string, scope: string) {
    await this.ready();
    const q = (await this.runtime.store.pendingQuestions(sessionId, scope))[0];
    return q
      ? {
          id: q.id,
          questions: q.questions,
          recovered:
            q.hostInstanceId !== this.hostInstanceId || this.isInterrupted(q),
        }
      : null;
  }
  async readDraft(
    sessionId: string,
    scope: string,
    p: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const current = () => {
      if (this.closing) throw Error("Questions are closing");
      signal?.throwIfAborted();
    };
    current();
    const id = z.string().uuid().parse(p.id);
    await this.ready();
    current();
    const result = await this.runtime.store.questionDraft({
      id,
      sessionId,
      scope,
      ...(this.enforceAccess
        ? {
            workspace: this.runtime.options.cwd,
            defaultControl: this.defaultDeviceControl,
          }
        : {}),
    });
    current();
    return result;
  }
  async saveDraft(
    sessionId: string,
    scope: string,
    p: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closing) throw Error("Questions are closing");
    signal?.throwIfAborted();
    const id = z.string().uuid().parse(p.id);
    const expectedRevision = draftRevisionSchema
      .max(Number.MAX_SAFE_INTEGER - 1)
      .parse(p.expectedRevision);
    const draft = draftSchema.parse(p.draft);
    if (Buffer.byteLength(JSON.stringify(draft)) > 512 * 1024)
      throw Error("Question draft exceeds 512 KiB");
    // Capture earlier writes before registering this save, avoiding a self-wait.
    // An admitted save may finish during close; new saves are rejected above.
    const earlier = Promise.all([...this.writes]);
    return this.writing(
      (async () => {
        await earlier;
        signal?.throwIfAborted();
        return this.runtime.store.saveQuestionDraft({
          id,
          sessionId,
          scope,
          expectedRevision,
          draft,
          ...(this.enforceAccess
            ? {
                workspace: this.runtime.options.cwd,
                defaultControl: this.defaultDeviceControl,
              }
            : {}),
        });
      })(),
    );
  }
  async respond(
    sessionId: string,
    scope: string,
    p: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closing) throw Error("Questions are closing");
    signal?.throwIfAborted();
    const id = z.string().uuid().parse(p.id);
    const draftRevision =
      p.draftRevision === undefined
        ? undefined
        : draftRevisionSchema.parse(p.draftRevision);
    // Keep the waiter reference across reads: cancellation may finish and remove
    // it, but an answer begun before that cancellation is still stale.
    const originalWaiter = this.questions.get(id);
    await this.ready();
    const q = (
      await this.runtime.store.pendingQuestions(sessionId, scope)
    ).find((q) => q.id === id);
    if (this.closing) throw Error("Questions are closing");
    signal?.throwIfAborted();
    if (!q) throw Error("Question expired or answered elsewhere");
    const live = this.questions.get(id);
    if (originalWaiter?.cancelling || live?.cancelling)
      throw Error(
        "Question was cancelled; reopen it to inspect its current state",
      );
    const interrupted = this.isInterrupted(q);
    if (q.hostInstanceId === this.hostInstanceId && !live && !interrupted)
      throw Error("Question expired or answered elsewhere");
    let answers: Record<string, string> | undefined;
    if (p.cancelled !== true) {
      answers = z
        .record(z.string(), z.string().min(1).max(100000))
        .parse(p.answers);
      if (
        Object.keys(answers).length !== q.questions.length ||
        q.questions.some((question) => !answers![question.id]?.trim())
      )
        throw Error("Answer every question explicitly");
    }
    const result = await this.writing(
      this.runtime.store.settleQuestion({
        id,
        sessionId,
        scope,
        hostInstanceId: this.hostInstanceId,
        answers,
        ...(draftRevision === undefined ? {} : { draftRevision }),
        ...(interrupted ? { recover: true } : {}),
        ...(this.enforceAccess
          ? {
              workspace: this.runtime.options.cwd,
              defaultControl: this.defaultDeviceControl,
            }
          : {}),
      }),
    );
    this.interrupted.delete(id);
    if (!result.recovered) this.questions.get(id)?.finish(answers);
    return { completed: true, recovered: result.recovered };
  }
  close() {
    this.closing = true;
    this.interrupted.clear();
    for (const q of this.questions.values()) q.finish(undefined);
  }
}
