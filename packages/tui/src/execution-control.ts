import type { Agent } from "../../core/src/index.ts";
import type { Runtime } from "../../runtime/src/index.ts";
import type { HikaroView } from "./index.ts";

import {
  executionItems,
  type ExecutionKind as Kind,
  type ExecutionItem as Item,
} from "../../runtime/src/execution-items.ts";
type LocalSource = {
  agent: Pick<
    Agent,
    | "holdQueue"
    | "pendingPrompts"
    | "updatePending"
    | "prioritizePending"
    | "removePending"
  >;
  runtime: Pick<Runtime, "terminals" | "childTasks" | "stopChild">;
  session: string;
};
export type ExecutionSource = {
  hold(): Promise<() => Promise<void>>;
  list(kind: Kind): Promise<Item[]>;
  detail(kind: Kind, id: string): Promise<Item>;
  act(kind: Kind, id: string, action: string, text?: string): Promise<void>;
};
export function localExecutionSource(source: LocalSource): ExecutionSource {
  return {
    async hold() {
      const release = source.agent.holdQueue();
      return async () => release();
    },
    async list(kind) {
      return executionItems(source.agent, source.runtime, source.session, kind);
    },
    async detail(kind, id) {
      const item = executionItems(
        source.agent,
        source.runtime,
        source.session,
        kind,
      ).find((t) => t.id === id);
      if (!item) throw Error("Item is no longer available");
      return item;
    },
    async act(kind, id, action, text) {
      if (kind === "queue") {
        if (action === "edit") source.agent.updatePending(id, text!);
        else if (action === "first") source.agent.prioritizePending(id);
        else if (action === "remove") source.agent.removePending(id);
        else throw Error("Unknown queue action");
      } else if (kind === "terminals") {
        if (action === "send")
          source.runtime.terminals.send(source.session, id, text!);
        else if (action === "stop")
          source.runtime.terminals.stop(source.session, id);
        else throw Error("Unknown terminal action");
      } else if (action === "stop")
        source.runtime.stopChild(source.session, id);
      else throw Error("Unknown child action");
    },
  };
}
export async function openExecutionControl(
  view: HikaroView,
  input: ExecutionSource | LocalSource,
) {
  const source = "agent" in input ? localExecutionSource(input) : input;
  const { panel, signal, close } = view.openModelPanel({
    yieldToApproval: true,
  });
  let release: (() => Promise<void>) | undefined;
  const names = {
    queue: "Pending messages",
    terminals: "Background terminals",
    children: "Child agents",
  };
  let message =
    "Pending dispatch is paused while this manager is open. Active work continues. Close to resume.";
  const confirm = async (title: string, detail: string) =>
    (
      await panel.choose(
        title,
        [
          { value: "cancel", label: "Cancel" },
          { value: "confirm", label: "Confirm" },
        ],
        detail,
        undefined,
        { search: false, cancelValue: "cancel", requireNoticeVisible: true },
      )
    ).value === "confirm";
  try {
    panel.progress("Pausing pending dispatch…");
    release = await source.hold();
    signal.throwIfAborted();
    for (;;) {
      const category = await panel.choose(
        "Execution manager",
        [
          { value: "queue", label: names.queue },
          { value: "terminals", label: names.terminals },
          { value: "children", label: names.children },
          { value: "close", label: "Close and resume queue" },
        ],
        message,
        undefined,
        { search: false },
      );
      if (category.value === "close") return;
      const kind = category.value as Kind;
      let page = 0;
      for (;;) {
        panel.progress(`Loading ${names[kind].toLowerCase()}…`);
        const all = await source.list(kind);
        signal.throwIfAborted();
        page = Math.min(page, Math.max(0, Math.ceil(all.length / 20) - 1));
        const choice = await panel.choose(
          `${names[kind]} · page ${page + 1}`,
          [
            ...all.slice(page * 20, (page + 1) * 20).map((t) => ({
              value: t.id,
              label: t.title,
              description: t.state,
            })),
            ...(page ? [{ value: "previous", label: "Previous page" }] : []),
            ...((page + 1) * 20 < all.length
              ? [{ value: "next", label: "Next page" }]
              : []),
            { value: "refresh", label: "Refresh" },
            { value: "back", label: "Back to manager" },
          ],
          all.length
            ? message
            : `No ${names[kind].toLowerCase()} in this session.`,
          undefined,
          { search: false, cancelValue: "back" },
        );
        if (choice.value === "back") break;
        if (choice.value === "refresh") continue;
        if (choice.value === "next") {
          page++;
          continue;
        }
        if (choice.value === "previous") {
          page--;
          continue;
        }
        try {
          for (;;) {
            panel.progress("Loading details…");
            const item = await source.detail(kind, choice.value);
            signal.throwIfAborted();
            if (!item)
              throw Error("Item is no longer available. Refresh the list.");
            const pending = panel.readDocument(
              `${names[kind]} · ${item.state}`,
              item.detail,
              [
                ...item.actions,
                { value: "refresh", label: "Refresh status / output" },
              ],
            );
            let refreshing = false;
            let active = true;
            const timer = setInterval(() => {
              if (!active || signal.aborted || refreshing) return;
              refreshing = true;
              void source
                .detail(kind, item.id)
                .then((latest) => {
                  if (active && !signal.aborted)
                    panel.updateDocument(
                      `${names[kind]} · ${latest.state}`,
                      latest.detail,
                    );
                })
                .catch((error) => {
                  if (active && !signal.aborted) {
                    view.setError(String(error));
                    close();
                  }
                })
                .finally(() => {
                  refreshing = false;
                });
            }, 500);
            let action;
            try {
              action = await pending;
            } finally {
              active = false;
              clearInterval(timer);
            }
            if (action.value === "back") break;
            if (action.value === "refresh") continue;
            if (action.value === "edit") {
              // Single-line input preserves existing multi-line messages unless explicitly replaced.
              const text = await panel.prompt(
                "Edit pending message",
                false,
                item.editText ?? "",
                { cancelValue: "" },
              );
              if (!text) continue;
              panel.progress("Applying action…");
              await source.act(kind, item.id, "edit", text);
              message = "Message updated; still queued.";
            } else if (action.value === "first") {
              panel.progress("Applying action…");
              await source.act(kind, item.id, "first");
              message = "Message moved to front; still queued.";
            } else if (action.value === "remove") {
              if (!(await confirm("Remove pending message?", item.title)))
                continue;
              panel.progress("Applying action…");
              await source.act(kind, item.id, "remove");
              message = "Message removed; it will not be sent.";
            } else if (action.value === "send") {
              const text = await panel.prompt(
                "Send a line to terminal",
                false,
                "",
                { cancelValue: "" },
              );
              if (
                !text ||
                !(await confirm(
                  "Send terminal input?",
                  `${item.title}\nInput: ${text}\nA newline will be appended.`,
                ))
              )
                continue;
              panel.progress("Applying action…");
              await source.act(kind, item.id, "send", text + "\n");
              message =
                "Input sent. Refresh output to verify the program response.";
            } else if (action.value === "stop") {
              if (!(await confirm("Stop this task?", item.title))) continue;
              panel.progress("Applying action…");
              await source.act(kind, item.id, "stop");
              message =
                "Stop requested. Refresh to confirm the final state; a request is not proof of exit.";
            }
            view.notice(message);
            break;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          message = error instanceof Error ? error.message : String(error);
          view.setError(message);
        }
      }
    }
  } catch (error) {
    if (!signal.aborted)
      view.setError(error instanceof Error ? error.message : String(error));
  } finally {
    close();
    await release?.().catch((error) => view.setError(String(error)));
  }
}
