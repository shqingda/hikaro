import type { HikaroView } from "../../tui/src/index.ts";
import type { WorkspaceSession } from "../../tui/src/workbench.ts";

export interface WorkspaceHandle {
  id: string;
  view: HikaroView;
  title(): string;
  state(): string;
  provider?(): string | undefined;
  attention?(): number;
  canClose(): boolean;
  prepareClose?(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Owns monitored sessions, independently of which terminal layout is visible. */
export class SessionWorkspace {
  private handles = new Map<string, WorkspaceHandle>();
  private unread = new Set<string>();
  private selected?: string;
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private transitions = 0;
  constructor(
    private create: (id: string) => Promise<WorkspaceHandle>,
    private show: (view: HikaroView) => void,
    private select?: (id: string) => Promise<void>,
    readonly limit = 8,
  ) {}
  get current() {
    return this.selected ? this.handles.get(this.selected) : undefined;
  }
  get switching() {
    return this.transitions > 0;
  }
  get(id: string) {
    return this.handles.get(id);
  }
  values() {
    return [...this.handles.values()];
  }
  assertCapacity() {
    if (this.closed) throw Error("Workspace is closing");
    if (this.handles.size >= this.limit)
      throw Error(
        `At most ${this.limit} sessions can be monitored. Use /close in an idle session before opening another.`,
      );
  }
  private serialized<T>(operation: () => Promise<T>) {
    const work = this.operations.then(operation);
    this.operations = work.catch(() => {});
    return work;
  }
  open(id: string, activate = true): Promise<WorkspaceHandle> {
    this.transitions++;
    return this.serialized(async () => {
      if (this.closed) throw Error("Workspace is closing");
      let handle = this.handles.get(id);
      if (!handle) {
        this.assertCapacity();
        handle = await this.create(id);
        if (this.closed) {
          await handle.close();
          throw Error("Workspace is closing");
        }
        this.handles.set(handle.id, handle);
      }
      if (!activate) {
        this.refresh();
        return handle;
      }
      await this.activate(handle);
      return handle;
    }).finally(() => {
      this.transitions--;
    });
  }
  private async activate(handle: WorkspaceHandle) {
    await this.current?.flush();
    if (this.closed) throw Error("Workspace is closing");
    if (this.current !== handle) this.current?.view.setActive(false);
    this.selected = handle.id;
    this.unread.delete(handle.id);
    this.show(handle.view);
    handle.view.setActive(true);
    this.refresh();
    await this.select?.(handle.id);
  }
  refresh(changed?: string) {
    if (this.closed) return;
    if (changed && changed !== this.selected) this.unread.add(changed);
    const sessions: WorkspaceSession[] = this.values().map((handle) => ({
      id: handle.id,
      title: handle.title(),
      state: handle.state(),
      current: handle.id === this.selected,
      unread: this.unread.has(handle.id),
      attention: handle.view.attentionCount + (handle.attention?.() ?? 0),
    }));
    for (const handle of this.handles.values())
      handle.view.setSessions(sessions);
  }
  close(id: string) {
    return this.serialized(async () => {
      const handle = this.handles.get(id);
      if (!handle) return;
      await handle.prepareClose?.();
      if (!handle.canClose()) {
        handle.view.notice(
          "This session remains monitored in the background until its work and approvals settle.",
        );
        const next = this.values().find((item) => item.id !== id);
        if (next) await this.activate(next);
        return;
      }
      if (this.handles.size === 1)
        throw Error("This is the last open session. Use /new or /quit.");
      await handle.flush();
      if (this.selected === id)
        await this.activate(this.values().find((item) => item.id !== id)!);
      this.handles.delete(id);
      this.unread.delete(id);
      await handle.close();
      this.refresh();
    });
  }
  /** Remove a session already deleted by the authoritative runtime. */
  forget(id: string) {
    return this.serialized(async () => {
      const handle = this.handles.get(id);
      if (!handle) return;
      if (this.selected === id) {
        handle.view.setActive(false);
        this.selected = undefined;
      }
      this.handles.delete(id);
      this.unread.delete(id);
      await handle.close();
      this.refresh();
    });
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    await this.operations;
    const results = await Promise.allSettled(
      this.values().map(async (handle) => {
        try {
          await handle.flush();
        } finally {
          await handle.close();
        }
      }),
    );
    this.handles.clear();
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
}
