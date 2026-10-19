/** Coalesce edits without postponing saves during continuous typing. No idle polling. */
export class DraftSaver {
  private pending = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  constructor(
    private save: (sessionId: string, text: string) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {}
  update(sessionId: string, text: string) {
    this.pending.set(sessionId, text);
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.onError);
    }, 300);
    this.timer.unref();
  }
  /** Undefined preserves the live editor when only the current model/settings change. */
  async restore(
    currentId: string,
    nextId: string,
    read: (id: string) => Promise<string>,
  ): Promise<string | undefined> {
    if (currentId === nextId) {
      await this.flush();
      return;
    }
    const text = await read(nextId);
    await this.flush();
    return text;
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) {
      await this.writing;
      return this.flush();
    }
    if (!this.pending.size) return;
    const drain = async () => {
      while (this.pending.size) {
        const [id, text] = this.pending.entries().next().value!;
        this.pending.delete(id);
        try {
          await this.save(id, text);
        } catch (error) {
          // Never replace a newer edit with a failed older snapshot.
          if (!this.pending.has(id)) this.pending.set(id, text);
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
    // An edit can arrive after drain resolves but before this continuation.
    // On failure the throw above deliberately prevents a retry loop.
    return this.flush();
  }
}
