import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Questions } from "../../../packages/runtime/src/planning.ts";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import { answerQuestion } from "../../../packages/tui/src/planning.ts";
import { QuestionDraftSaver } from "../../../packages/tui/src/question-drafts.ts";
import { QuestionService, type QuestionView } from "./question-service.ts";

// Never aliases an RPC default, attached client identity.
export const localQuestionScope = "standalone:tui";
export class LocalQuestions {
  private service: QuestionService;
  private selection = new AbortController();
  private sessionId?: string;
  private closed = false;
  private panel?: Promise<void>;
  private drafts = new Set<QuestionDraftSaver>();
  private closingWriters = new Set<QuestionDraftSaver>();
  private closingDrafts?: Promise<void>;
  constructor(
    private runtime: Runtime,
    private view: () => HikaroView,
  ) {
    this.service = new QuestionService(runtime);
  }
  async ready() {
    await this.closingDrafts;
    await this.service.ready();
  }
  invalidate() {
    this.selection.abort();
    this.sessionId = undefined;
  }
  async select(sessionId: string) {
    if (this.closed) return;
    this.invalidate();
    this.selection = new AbortController();
    this.sessionId = sessionId;
    const signal = this.selection.signal;
    await this.runtime.session(sessionId);
    if (this.closed || signal.aborted) return;
    const question = await this.service.read(sessionId, localQuestionScope);
    if (!this.closed && !signal.aborted && question)
      this.view().notice(
        "Unanswered questions saved for this session. Use /questions to answer or dismiss them.",
      );
  }
  ask(
    questions: Questions,
    signal: AbortSignal,
    executionSessionId: string,
    scope?: string,
  ) {
    if (scope !== undefined && scope !== localQuestionScope)
      throw Error("Question belongs to another identity");
    const sessionId = this.runtime.approvalAuthority(executionSessionId);
    return this.service.ask(
      questions,
      signal,
      executionSessionId,
      localQuestionScope,
      async (question) => {
        if (!this.closed && this.sessionId === sessionId) {
          const selection = this.selection.signal;
          try {
            await this.show(question, sessionId, signal);
          } catch (error) {
            // A busy or failed panel must not orphan the saved live question.
            if (!this.closed && !signal.aborted && !selection.aborted) {
              this.view().setError(String(error));
              this.view().notice(
                "Question saved. Close the current panel, then use /questions to answer.",
              );
            }
          }
        }
      },
    );
  }
  private async show(
    question: QuestionView,
    sessionId: string,
    runSignal?: AbortSignal,
  ) {
    const selection = this.selection.signal;
    if (this.panel) await this.panel;
    if (
      this.closed ||
      selection.aborted ||
      this.sessionId !== sessionId ||
      runSignal?.aborted
    )
      return;
    const signal = runSignal
      ? AbortSignal.any([runSignal, selection])
      : selection;
    const work = this.answer(question, sessionId, signal);
    this.panel = work;
    try {
      await work;
    } finally {
      if (this.panel === work) this.panel = undefined;
    }
  }
  private async answer(
    question: QuestionView,
    sessionId: string,
    signal: AbortSignal,
  ) {
    const snapshot = await this.service.readDraft(
      sessionId,
      localQuestionScope,
      { id: question.id },
      signal,
    );
    signal.throwIfAborted();
    const saver = new QuestionDraftSaver(
      snapshot,
      (expectedRevision, draft) => {
        // Only the frozen, already-open local panel drains after shutdown.
        // The worker still checks pending identity, schema and revision; no
        // live answer or RPC request is admitted after QuestionService.close.
        if (this.closed) {
          if (!this.closingWriters.has(saver))
            throw Error("Question draft is closed");
          return this.runtime.store.saveQuestionDraft({
            id: question.id,
            sessionId,
            scope: localQuestionScope,
            expectedRevision,
            draft,
          });
        }
        signal.throwIfAborted();
        return this.service.saveDraft(sessionId, localQuestionScope, {
          id: question.id,
          expectedRevision,
          draft,
        });
      },
      (error) => {
        if (!signal.aborted)
          this.view().setError(`Answer draft not saved: ${String(error)}`);
      },
    );
    this.drafts.add(saver);
    try {
      await answerQuestion(
        this.view(),
        question,
        signal,
        (answers, draftRevision) => {
          signal.throwIfAborted();
          return this.service.respond(
            sessionId,
            localQuestionScope,
            {
              id: question.id,
              draftRevision,
              ...(answers ? { answers } : { cancelled: true }),
            },
            signal,
          );
        },
        saver,
      );
    } finally {
      saver.stop();
      this.drafts.delete(saver);
    }
  }
  async open() {
    if (this.closed || !this.sessionId) return;
    if (this.panel) throw Error("Close the current question first");
    const sessionId = this.sessionId,
      signal = this.selection.signal;
    await this.runtime.session(sessionId);
    if (this.closed || signal.aborted) return;
    const question = await this.service.read(sessionId, localQuestionScope);
    if (this.closed || signal.aborted) return;
    if (!question) {
      this.view().notice("No unanswered questions in this session.");
      return;
    }
    await this.show(question, sessionId);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const drafts = [...this.drafts];
    this.closingWriters = new Set(drafts);
    this.closingDrafts = Promise.allSettled(
      drafts.map((draft) =>
        draft.finish().finally(() => this.closingWriters.delete(draft)),
      ),
    ).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          console.error(
            `Answer draft could not be saved before exit: ${String(result.reason)}`,
          );
    });
    this.service.close();
    this.invalidate();
  }
}
