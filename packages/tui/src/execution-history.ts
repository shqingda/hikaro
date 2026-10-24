import type { ExecutionItem } from "../../runtime/src/execution-items.ts";
import type {
  ExecutionHistoryCursor,
  ExecutionHistoryPage,
} from "../../runtime/src/execution-history.ts";
import type { HikaroView } from "./index.ts";
import type { ModelPanel } from "./model-panel.ts";

export type ExecutionHistorySource = {
  list(
    cursor: ExecutionHistoryCursor,
    signal: AbortSignal,
  ): Promise<ExecutionHistoryPage>;
  detail(
    id: string,
    snapshot: number | undefined,
    signal: AbortSignal,
  ): Promise<ExecutionItem>;
};

/** Shared reader; the caller owns the panel and any existing manager hold. */
export async function readExecutionHistory(
  panel: ModelPanel,
  signal: AbortSignal,
  source: ExecutionHistorySource,
  id?: string,
  closeLabel = "Close history",
) {
  const cursors: Array<number | undefined> = [undefined];
  let page = 0;
  let snapshot: number | undefined;
  const detail = async (runId: string, at?: number) => {
    signal.throwIfAborted();
    panel.progress("Loading execution details…");
    const item = await source.detail(runId, at, signal);
    signal.throwIfAborted();
    if (item.id !== runId) throw Error("Run identity does not match");
    // History never exposes actions, even if an older source supplies them.
    await panel.readDocument(
      `Execution history · ${item.state}`,
      item.detail,
      [],
    );
  };
  if (id !== undefined) await detail(id);
  for (;;) {
    signal.throwIfAborted();
    panel.progress("Loading execution history…");
    const history = await source.list(
      snapshot === undefined ? {} : { snapshot, before: cursors[page] },
      signal,
    );
    signal.throwIfAborted();
    if (snapshot !== undefined && history.snapshot !== snapshot)
      throw Error("History snapshot changed; reopen history");
    if (
      !Number.isSafeInteger(history.snapshot) ||
      history.snapshot < 0 ||
      (history.nextBefore !== null &&
        (!Number.isSafeInteger(history.nextBefore) ||
          history.nextBefore < 1 ||
          history.nextBefore > history.snapshot ||
          (cursors[page] !== undefined &&
            history.nextBefore >= cursors[page]!)))
    )
      throw Error("Invalid history cursor; reopen history");
    snapshot = history.snapshot;
    const choice = await panel.choose(
      `Execution history · page ${page + 1}`,
      [
        ...history.items.map((item, index) => ({
          value: `item:${index}`,
          label: item.title,
          description: item.state,
        })),
        ...(page ? [{ value: "previous", label: "Previous page" }] : []),
        ...(history.nextBefore !== null
          ? [{ value: "next", label: "Next page" }]
          : []),
        { value: "find", label: "Open run by ID" },
        { value: "refresh", label: "Refresh history" },
        { value: "close", label: closeLabel },
      ],
      history.items.length
        ? "Read-only saved runs. Missing end events do not prove a run is active or stopped. Refresh to include newer events."
        : history.nextBefore !== null
          ? "No new run entries on this page. More source events remain; continue to the next page."
          : "No saved runs on this page.",
      undefined,
      { search: false, cancelValue: "close", enterAction: "read" },
    );
    if (choice.value === "close") return;
    if (choice.value === "previous") {
      page--;
      continue;
    }
    if (choice.value === "next") {
      cursors[++page] = history.nextBefore!;
      continue;
    }
    if (choice.value === "refresh") {
      page = 0;
      snapshot = undefined;
      cursors.splice(0, cursors.length, undefined);
      continue;
    }
    if (choice.value === "find") {
      const runId = (
        await panel.prompt("Open run by ID", false, "", { cancelValue: "" })
      ).trim();
      if (runId) await detail(runId);
      continue;
    }
    const item = history.items[Number(choice.value.slice("item:".length))];
    if (item) await detail(item.id, snapshot);
  }
}

/** Direct history inspection does not hold or mutate the execution queue. */
export async function browseExecutionHistory(
  view: HikaroView,
  source: ExecutionHistorySource,
  id?: string,
  selectionSignal?: AbortSignal,
) {
  if (selectionSignal?.aborted) return;
  const { panel, signal, close } = view.openModelPanel({
    yieldToApproval: true,
  });
  selectionSignal?.addEventListener("abort", close, { once: true });
  try {
    await readExecutionHistory(panel, signal, source, id);
  } catch (error) {
    if (!signal.aborted) view.setError(String(error));
  } finally {
    selectionSignal?.removeEventListener("abort", close);
    close();
  }
}
