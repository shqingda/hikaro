import type { AgentEvent } from "../../core/src/types.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";
import type { ExecutionItem } from "./execution-items.ts";

export type ExecutionHistoryCursor = { snapshot?: number; before?: number };
export type ExecutionHistoryPage = {
  items: ExecutionItem[];
  snapshot: number;
  nextBefore: number | null;
};
function historyItem(
  id: string,
  start: AgentEvent | undefined,
  end: AgentEvent | undefined,
  recent = false,
): ExecutionItem {
  const text = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 4000) : "not recorded";
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
      : recent
        ? "not in recent event window"
        : "not recorded";
  const model = start?.data.operation
    ? text(start.data.operation)
    : `${text(start?.data.provider)}/${text(start?.data.model)}`;
  const usage =
    typeof end?.data.usageText === "string"
      ? end.data.usageText
      : JSON.stringify(end?.data.usage ?? {});
  return {
    id,
    title: `${time(start ?? end)} · ${id.slice(0, 36)}`,
    state: status,
    detail: `Run: ${id}\nState: ${status}\nStarted: ${time(start)}\nEnded: ${time(end)}\nExecution: ${model}\nError: ${text(end?.data.error)}\nUsage: ${usage.slice(0, 2000)}\n\nRead-only history${recent ? " from the latest 200 run events (up to 100 runs)" : " from recorded run events"}. Missing end events do not prove a run is active or stopped. Read output in the session transcript. No operation will be replayed.`,
    actions: [],
  };
}
export async function executionHistoryPage(
  store: Pick<SQLiteStore, "runHistoryPage">,
  sessionId: string,
  cursor: ExecutionHistoryCursor = {},
): Promise<ExecutionHistoryPage> {
  const page = await store.runHistoryPage(sessionId, cursor);
  return {
    ...page,
    items: page.items.map(({ id, start, end }) => ({
      ...historyItem(id, start, end),
      // Details have a separate bounded endpoint. Repeating escaped error and
      // model fields across a page can exceed the RPC frame limit.
      detail: "",
    })),
  };
}
export async function executionHistoryDetail(
  store: Pick<SQLiteStore, "runHistoryDetail">,
  sessionId: string,
  id: string,
  snapshot?: number,
): Promise<ExecutionItem> {
  const run = await store.runHistoryDetail(sessionId, id, snapshot);
  if (!run) throw Error("Recorded run not found in this session");
  return historyItem(id, run.start, run.end);
}

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
  return [...runs]
    .slice(0, 100)
    .map(([id, { start, end }]) => historyItem(id, start, end, true));
}
