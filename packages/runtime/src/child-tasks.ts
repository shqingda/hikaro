import type { Agent } from "../../core/src/index.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";

/** Delegated task history and live control share one subtree boundary. */
export class ChildTasks {
  constructor(private readonly store: SQLiteStore) {}
  readonly live = new Map<
    string,
    {
      id: string;
      parent: string;
      task: string;
      state: string;
      output: string;
      stopping: boolean;
      child?: Agent;
    }
  >();
  /** Saved outcomes from earlier hosts; live records in `children` win. */
  private restoredChildren = new Map<
    string,
    { id: string; parent: string; task: string; state: string; output: string }
  >();
  async load(parent: string) {
    const rows = await this.store.childTaskTree(parent);
    const owned = new Set(rows.map((row) => row.id));
    for (const [id, row] of this.restoredChildren)
      if (!owned.has(id) && this.isDescendant(parent, row.parent))
        this.restoredChildren.delete(id);
    for (const row of rows)
      this.restoredChildren.set(row.id, {
        id: row.id,
        parent: row.parentId,
        task: row.task,
        // A record still running in storage belonged to a host that exited.
        state: ["starting", "running", "stopping"].includes(row.state)
          ? "interrupted"
          : row.state,
        output: row.output,
      });
  }
  private isDescendant(root: string, owner: string) {
    for (let id: string | undefined = owner, hops = 0; id && hops < 6; hops++) {
      if (id === root) return true;
      id = this.live.get(id)?.parent ?? this.restoredChildren.get(id)?.parent;
    }
    return false;
  }
  persist(record: {
    id: string;
    parent: string;
    task: string;
    state: string;
    output: string;
  }) {
    // History is best effort: losing it must not fail the delegated work.
    return this.store
      .saveChildTask({
        id: record.id,
        parentId: record.parent,
        task: record.task,
        state: record.state,
        output: record.output,
      })
      .catch(() => {});
  }
  /** Every delegated descendant of `parent`, depth-first in start order. */
  list(parent: string) {
    const items = [
      ...[...this.restoredChildren.values()].filter(
        (row) => !this.live.has(row.id),
      ),
      ...this.live.values(),
    ] as Array<{
      id: string;
      parent: string;
      task: string;
      state: string;
      output: string;
      stopping?: boolean;
      child?: Agent;
    }>;
    const tree: Array<{
      id: string;
      parentId: string;
      depth: number;
      task: string;
      state: string;
      output: string;
    }> = [];
    const visit = (owner: string, depth: number) => {
      // Delegation stops at depth 2; the bound also guards against bad links.
      if (depth > 4) return;
      for (const item of items.filter((row) => row.parent === owner)) {
        const snapshot = item.child?.snapshot();
        tree.push({
          id: item.id,
          parentId: item.parent,
          depth,
          task: item.task,
          state:
            item.stopping && snapshot?.busy
              ? "stopping"
              : snapshot?.runStatus === "idle"
                ? "starting"
                : (snapshot?.runStatus ?? item.state),
          output: snapshot?.stream || item.output,
        });
        visit(item.id, depth + 1);
      }
    };
    visit(parent, 1);
    return tree;
  }
  stop(parent: string, id: string) {
    const item = this.live.get(id);
    if (!item || !this.list(parent).some((row) => row.id === id))
      throw Error("Child task not found in this session");
    if (!item.child?.busy) return;
    item.stopping = true;
    item.child.cancel();
  }
}
