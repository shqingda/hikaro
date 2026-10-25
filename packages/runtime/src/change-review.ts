import type { SQLiteStore } from "../../storage/src/index.ts";
import type { ChangeJournal, FileChange } from "../../tools/src/changes.ts";
import { ChangeObservations } from "../../tools/src/change-observations.ts";

export type ReviewEntry = Omit<FileChange, "after" | "state"> & {
  after: string | null;
  state: FileChange["state"] | "observed";
  sessionId: string;
  depth: number;
  source: "file" | "shell" | "plugin";
  readOnly: boolean;
  callId?: string;
  plan?: import("../../core/src/change-evidence.ts").PlanReference;
};
export type ReviewFilter = {
  source?: ReviewEntry["source"];
  owner?: string;
  runId?: string;
  planId?: string;
  step?: number;
};
const observationKey = (
  callId: string,
  row: Pick<ReviewEntry, "path" | "before" | "after">,
) => JSON.stringify([callId, row.path, row.before, row.after]);

/** Read access to a root includes delegated descendants, never unrelated forks. */
export class ChangeReview {
  constructor(
    private store: SQLiteStore,
    private journal: ChangeJournal,
    readonly observations: ChangeObservations,
  ) {}
  async owners(root: string) {
    const rows = await this.store.childTaskTree(root);
    const depths = new Map<string, number>([[root, 0]]);
    for (let pass = 0; pass < 4; pass++)
      for (const row of rows) {
        const parent = depths.get(row.parentId);
        if (parent !== undefined && !depths.has(row.id))
          depths.set(row.id, parent + 1);
      }
    return depths;
  }
  async list(root: string, filter: ReviewFilter = {}) {
    const owners = await this.owners(root);
    const items: ReviewEntry[] = [];
    const warnings = new Set<string>();
    if (owners.size >= 201)
      warnings.add("Child history may exceed the retained subtree window.");
    for (const [sessionId, depth] of owners) {
      if (filter.owner && filter.owner !== sessionId) continue;
      const reliable = await this.journal.list(sessionId);
      const observed = await this.observations.list(sessionId);
      const reliableKeys = new Set<string>();
      for (const entry of reliable) {
        if (entry.origin) {
          reliableKeys.add(observationKey(entry.origin.callId, entry));
          if (entry.origin.parentCallId !== undefined)
            reliableKeys.add(observationKey(entry.origin.parentCallId, entry));
        }
        items.push({
          ...entry,
          sessionId,
          depth,
          source: "file",
          readOnly: sessionId !== root,
        });
      }
      for (const entry of observed) {
        // Only an exact call/path/hash match can coalesce observation with an authoritative write.
        if (reliableKeys.has(observationKey(entry.callId, entry))) continue;
        items.push({
          ...entry,
          sessionId,
          depth,
          readOnly: true,
          state: "observed",
        });
      }
      for (const warning of await this.observations.warnings(sessionId))
        warnings.add(warning);
      if (items.length > 10000)
        throw Error(
          "Combined change history exceeds 10,000 records; narrow the task filter.",
        );
    }
    return {
      items: items
        .filter(
          (row) =>
            (!filter.source || row.source === filter.source) &&
            (!filter.runId || row.runId === filter.runId) &&
            (!filter.planId ||
              (() => {
                const ref =
                  row.state === "observed" ? row.plan : row.origin?.plan;
                return (
                  ref?.sessionId === root &&
                  ref.planId === filter.planId &&
                  (filter.step === undefined || (ref.step ?? 0) === filter.step)
                );
              })()),
        )
        .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id)),
      warnings: [...warnings],
    };
  }
  async detail(
    root: string,
    target: Pick<ReviewEntry, "sessionId" | "source" | "id">,
  ) {
    const depth = (await this.owners(root)).get(target.sessionId);
    if (depth === undefined) throw Error("Change not found in this task tree");
    if (target.source === "file") {
      const result = await this.journal.detail(target.sessionId, target.id);
      return {
        ...result,
        entry: {
          ...result.entry,
          sessionId: target.sessionId,
          depth,
          source: "file" as const,
          readOnly: target.sessionId !== root,
        },
      };
    }
    const result = await this.observations.detail(target.sessionId, target.id);
    if (result.entry.source !== target.source)
      throw Error("Change source does not match");
    return {
      ...result,
      entry: {
        ...result.entry,
        sessionId: target.sessionId,
        depth,
        state: "observed" as const,
        readOnly: true,
      },
    };
  }
}
