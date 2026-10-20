import type { AgentEvent } from "../../core/src/types.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";
import type { ExecutionItem } from "./execution-items.ts";

/** A bounded audit view: absence of an end event is never evidence of exit. */
export async function executionHistory(
  store: Pick<SQLiteStore, "recentRunEvents">,
  sessionId: string,
): Promise<ExecutionItem[]> {
  const runs = new Map<string, { start?: AgentEvent; end?: AgentEvent }>();
  for (const event of await store.recentRunEvents(sessionId)) {
    const id = event.data.runId;
    if (typeof id !== "string" || !id) continue;
    const run = runs.get(id) ?? {};
    if (event.type === "run.start") run.start ??= event;
    else if (event.type === "run.end") run.end ??= event;
    runs.set(id, run);
  }
  const text = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 4000) : "not recorded";
  return [...runs].slice(0, 100).map(([id, { start, end }]) => {
    const status =
      end &&
      ["completed", "failed", "cancelled"].includes(String(end.data.status))
        ? String(end.data.status)
        : end
          ? "unknown"
          : "unknown · no recorded end";
    const time = (event?: AgentEvent) =>
      event
        ? new Date(event.timestamp).toISOString()
        : "not in recent event window";
    const model = start?.data.operation
      ? text(start.data.operation)
      : `${text(start?.data.provider)}/${text(start?.data.model)}`;
    return {
      id,
      title: `${time(start ?? end)} · ${id.slice(0, 36)}`,
      state: status,
      detail: `Run: ${id}\nState: ${status}\nStarted: ${time(start)}\nEnded: ${time(end)}\nExecution: ${model}\nError: ${text(end?.data.error)}\nUsage: ${JSON.stringify(end?.data.usage ?? {}).slice(0, 2000)}\n\nRead-only history from the latest 200 run events (up to 100 runs). Missing end events do not prove a run is active or stopped. Read output in the session transcript. No operation will be replayed.`,
      actions: [],
    };
  });
}
