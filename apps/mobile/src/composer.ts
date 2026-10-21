import * as z from "zod";

const recordSchema = z.object({
  session: z.object({
    id: z.string().min(1).max(128),
    title: z.string().max(100000),
    cwd: z.string().max(100000),
    createdAt: z.number(),
  }),
  text: z.string().max(100000),
  submission: z
    .object({
      id: z.string().min(1).max(128),
      status: z.enum(["pending", "unknown", "failed"]),
    })
    .optional(),
});
export type DraftRecord = z.infer<typeof recordSchema>;
export type DraftSession = DraftRecord["session"];
export interface DraftStore {
  load(scope: string, sessionId?: string): Promise<DraftRecord | null>;
  save(scope: string, record: DraftRecord): Promise<void>;
}
export function parseDraft(data: string): DraftRecord {
  if (data.length > 2000000) throw Error("Draft capacity exceeded");
  return recordSchema.parse(JSON.parse(data));
}
export type ComposerState = {
  record: DraftRecord | null;
  loading: boolean;
  saving: boolean;
  sending: boolean;
  error: string | null;
};
export const emptyComposer = (): ComposerState => ({
  record: null,
  loading: false,
  saving: false,
  sending: false,
  error: null,
});
type Outcome = "pending" | "acknowledged" | "completed" | "failed" | "unknown";

/** A separate durable outbox. Reconnection may query IDs, never replay text. */
export class MobileComposer {
  state = emptyComposer();
  private scope: string | null = null;
  private identity = 0;
  private selection = 0;
  private writeVersion = 0;
  private queue: Promise<void> = Promise.resolve();
  private checking?: Promise<void>;
  constructor(
    private store: DraftStore,
    private changed: (state: ComposerState) => void,
  ) {}
  private update(patch: Partial<ComposerState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  bind(scope: string | null) {
    if (scope === this.scope) return;
    this.identity++;
    this.scope = scope;
    this.hide();
    this.update(emptyComposer());
    // Old operations are fenced; their failures cannot prevent a new identity loading.
    this.queue = this.queue.catch(() => {});
  }
  hide() {
    this.selection++;
    this.checking = undefined;
    this.update({
      ...emptyComposer(),
      record: this.state.record,
      error: this.state.error,
    });
  }
  flush() {
    return this.queue;
  }
  async select(session?: DraftSession | null) {
    const selection = ++this.selection,
      identity = this.identity,
      scope = this.scope;
    this.update({ loading: true });
    try {
      await this.flush();
      if (selection !== this.selection || identity !== this.identity) return;
      const saved =
        scope && session !== null
          ? await this.store.load(scope, session?.id)
          : null;
      if (selection !== this.selection || identity !== this.identity) return;
      if (saved && session && saved.session.id !== session.id)
        throw Error("Draft session mismatch");
      const record = saved
        ? recordSchema.parse(saved)
        : session
          ? recordSchema.parse({ session, text: "" })
          : null;
      if (record?.submission) record.submission.status = "unknown";
      this.update({ ...emptyComposer(), record });
    } catch (error) {
      if (selection === this.selection)
        this.update({
          loading: false,
          error: "草稿未能读取或保存，原文已保留。请重试保存。",
        });
      throw error;
    }
  }
  private persist(record: DraftRecord): Promise<void> {
    const identity = this.identity,
      scope = this.scope,
      version = ++this.writeVersion;
    if (!scope) return Promise.reject(Error("No draft identity"));
    this.update({ record, saving: true, error: null });
    const save = async () => {
      if (identity !== this.identity || version !== this.writeVersion) return;
      await this.store.save(scope, record);
    };
    const task = this.queue.then(save, save);
    this.queue = task;
    void task.then(
      () => {
        if (identity === this.identity && this.state.record === record)
          this.update({ saving: false });
      },
      () => {
        if (identity === this.identity && this.state.record === record)
          this.update({
            saving: false,
            error: "草稿保存失败，原文仍在此处。请重试保存后再离开。",
          });
      },
    );
    return task;
  }
  edit(sessionId: string, text: string) {
    if (this.state.loading) throw Error("Draft is loading");
    const record = this.state.record;
    if (!record || record.session.id !== sessionId)
      throw Error("Draft selection changed");
    if (record.submission) throw Error("Submission is unresolved");
    if (text.length > 100000) throw Error("Draft capacity exceeded");
    void this.persist({ session: record.session, text }).catch(() => {});
  }
  retrySave() {
    if (this.state.loading) return Promise.reject(Error("Draft is loading"));
    if (!this.state.record) return Promise.reject(Error("No draft"));
    return this.persist(this.state.record);
  }
  async restoreDraft(sessionId: string) {
    const record = this.state.record;
    if (
      !record ||
      record.session.id !== sessionId ||
      this.state.sending ||
      this.state.loading
    )
      throw Error("Draft selection changed or submission pending");
    await this.persist({ session: record.session, text: record.text });
  }
  private settle(
    scope: string,
    identity: number,
    record: DraftRecord,
    status: Outcome,
  ) {
    const id = record.submission!.id;
    const save = async () => {
      if (identity !== this.identity) return;
      const current = await this.store.load(scope, record.session.id);
      if (identity !== this.identity || current?.submission?.id !== id) return;
      const next: DraftRecord = ["acknowledged", "completed"].includes(status)
        ? { session: current.session, text: "" }
        : {
            ...current,
            submission: {
              id,
              status: status === "failed" ? "failed" : "unknown",
            },
          };
      await this.store.save(scope, next);
      if (
        identity === this.identity &&
        this.state.record?.submission?.id === id
      )
        this.update({ record: next, saving: false, error: null });
    };
    const task = this.queue.then(save, save);
    this.queue = task;
    void task.catch(() => {
      if (
        identity === this.identity &&
        this.state.record?.submission?.id === id
      )
        this.update({
          error: "发送状态未能保存，原文已保留。请核对回执后重试。",
        });
    });
    return task;
  }
  async send(
    sessionId: string,
    id: string,
    dispatch: (text: string) => Promise<unknown>,
  ) {
    const record = this.state.record,
      scope = this.scope,
      identity = this.identity,
      selection = this.selection;
    if (
      !scope ||
      !record ||
      record.session.id !== sessionId ||
      this.state.loading ||
      this.state.sending
    )
      throw Error("Draft selection changed");
    if (record.submission || !record.text.trim())
      throw Error("Empty or unresolved draft");
    const pending = recordSchema.parse({
      ...record,
      submission: { id, status: "pending" },
    });
    this.update({ sending: true });
    try {
      await this.persist(pending);
      if (
        identity !== this.identity ||
        selection !== this.selection ||
        this.state.record !== pending
      )
        throw Error("Draft selection changed before send");
      await dispatch(pending.text);
      await this.settle(scope, identity, pending, "acknowledged");
    } catch (error) {
      await this.settle(scope, identity, pending, "unknown").catch(() => {});
      throw error;
    } finally {
      if (selection === this.selection && identity === this.identity)
        this.update({ sending: false });
    }
  }
  reconcile(query: (id: string) => Promise<Outcome>) {
    if (this.checking) return this.checking;
    const record = this.state.record,
      scope = this.scope,
      identity = this.identity;
    if (
      !scope ||
      !record?.submission ||
      this.state.sending ||
      this.state.loading
    )
      return Promise.resolve();
    const task = (async () => {
      try {
        const status = await query(record.submission!.id);
        await this.settle(scope, identity, record, status);
      } catch (error) {
        if (
          identity === this.identity &&
          this.state.record?.submission?.id === record.submission!.id
        )
          this.update({
            error: "暂时无法核对发送结果，原文已保留。请连接电脑后重试。",
          });
        throw error;
      }
    })();
    this.checking = task;
    void task
      .finally(() => {
        if (this.checking === task) this.checking = undefined;
      })
      .catch(() => {});
    return task;
  }
}
