import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Questions } from "../../../packages/runtime/src/planning.ts";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import { answerQuestion } from "../../../packages/tui/src/planning.ts";
import { QuestionService, type QuestionView } from "./question-service.ts";

// Never aliases an RPC default, attached client, or paired device identity.
export const localQuestionScope = "standalone:tui";
export class LocalQuestions {
  private service: QuestionService;
  private selection = new AbortController();
  private sessionId?: string;
  private closed = false;
  private panel?: Promise<void>;
  constructor(
    private runtime: Runtime,
    private view: () => HikaroView,
  ) {
    this.service = new QuestionService(runtime);
  }
  ready() {
    return this.service.ready();
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
    const work = answerQuestion(this.view(), question, signal, (answers) => {
      signal.throwIfAborted();
      return this.service.respond(
        sessionId,
        localQuestionScope,
        {
          id: question.id,
          ...(answers ? { answers } : { cancelled: true }),
        },
        signal,
      );
    });
    this.panel = work;
    try {
      await work;
    } finally {
      if (this.panel === work) this.panel = undefined;
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
    this.closed = true;
    this.service.close();
    this.invalidate();
  }
}
