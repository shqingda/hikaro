import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Questions } from "../../../packages/runtime/src/planning.ts";
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
      finish: (answers: Record<string, string> | undefined) => void;
    }
  >();
  private writes = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private runtime: Runtime,
    private hostInstanceId: string = randomUUID(),
    private enforceAccess = false,
  ) {}
  async ready() {
    while (this.writes.size) await Promise.all([...this.writes]);
  }
  private writing<T>(work: Promise<T>) {
    this.writes.add(work);
    void work.finally(() => this.writes.delete(work)).catch(() => {});
    return work;
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
        void this.writing(
          saved.then(() =>
            this.runtime.store.settleQuestion({
              id,
              sessionId,
              scope,
              hostInstanceId: this.hostInstanceId,
            }),
          ),
        ).then(
          () => finish(undefined),
          (error) => {
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
          recovered: q.hostInstanceId !== this.hostInstanceId,
        }
      : null;
  }
  async respond(
    sessionId: string,
    scope: string,
    p: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closing) throw Error("Questions are closing");
    signal?.throwIfAborted();
    await this.ready();
    const id = z.string().uuid().parse(p.id);
    const q = (
      await this.runtime.store.pendingQuestions(sessionId, scope)
    ).find((q) => q.id === id);
    if (this.closing) throw Error("Questions are closing");
    signal?.throwIfAborted();
    if (
      !q ||
      (q.hostInstanceId === this.hostInstanceId && !this.questions.has(id))
    )
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
        ...(this.enforceAccess ? { workspace: this.runtime.options.cwd } : {}),
      }),
    );
    this.questions.get(id)?.finish(answers);
    return { completed: true, recovered: result.recovered };
  }
  close() {
    this.closing = true;
    for (const q of this.questions.values()) q.finish(undefined);
  }
}
