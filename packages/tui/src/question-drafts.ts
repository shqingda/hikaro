import type {
  QuestionDraft,
  QuestionDraftSnapshot,
  QuestionDraftSaveResult,
} from "../../protocol/src/contracts.ts";

/** One question panel owns one revision stream. Conflicts require reopening. */
export class QuestionDraftSaver {
  readonly initial: QuestionDraft | null;
  revision: number;
  private pending?: QuestionDraft;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private conflict?: Error;
  private stopped = false;
  private finishing = false;
  private finishWork?: Promise<void>;
  constructor(
    snapshot: QuestionDraftSnapshot,
    private save: (
      expectedRevision: number,
      draft: QuestionDraft,
    ) => Promise<QuestionDraftSaveResult>,
    private onError: (error: unknown) => void,
  ) {
    this.initial = snapshot.draft;
    this.revision = snapshot.revision;
  }
  update(draft: QuestionDraft) {
    if (this.stopped || this.finishing) return;
    this.pending = structuredClone(draft);
    if (this.timer || this.writing || this.conflict) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.onError);
    }, 300);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.conflict) throw this.conflict;
    if (this.writing) {
      await this.writing;
      return this.flush();
    }
    if (this.stopped || !this.pending) return;
    const drain = async () => {
      while (!this.stopped && this.pending) {
        const draft = this.pending;
        this.pending = undefined;
        try {
          const result = await this.save(this.revision, draft);
          if ("conflict" in result) {
            this.conflict = Error(
              "Answer draft changed in another view. Close this panel and reopen the question to review the saved draft.",
            );
            throw this.conflict;
          }
          this.revision = result.revision;
        } catch (error) {
          // Keep the most recent edit, but never retry in an automatic loop.
          this.pending ??= draft;
          throw error;
        }
      }
    };
    this.writing = drain();
    try {
      await this.writing;
    } finally {
      this.writing = undefined;
    }
    return this.flush();
  }
  stop() {
    if (this.finishing) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
  /** Freeze edits, but let the final snapshot follow an already pending write. */
  finish(): Promise<void> {
    if (this.finishWork) return this.finishWork;
    this.finishing = true;
    this.finishWork = this.flush().finally(() => {
      this.finishing = false;
      this.stop();
    });
    return this.finishWork;
  }
}
