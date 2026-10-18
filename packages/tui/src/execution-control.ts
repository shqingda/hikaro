import type { Agent } from "../../core/src/index.ts";
import type { Runtime } from "../../runtime/src/index.ts";
import type { HikaroView } from "./index.ts";

type Kind = "queue" | "terminals" | "children";
type Item = {
  id: string;
  title: string;
  state: string;
  detail: string;
  actions: { value: string; label: string }[];
};
export async function openExecutionControl(
  view: HikaroView,
  source: {
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
  },
) {
  const { panel, signal, close } = view.openModelPanel({
    yieldToApproval: true,
  });
  const release = source.agent.holdQueue();
  const names = {
    queue: "Pending messages",
    terminals: "Background terminals",
    children: "Child agents",
  };
  let message =
    "Pending dispatch is paused while this manager is open. Active work continues. Close to resume.";
  const items = (kind: Kind): Item[] => {
    if (kind === "queue")
      return source.agent.pendingPrompts().map((q, i) => ({
        id: q.id,
        title: `${i + 1}. ${q.text}`,
        state: `${q.attachments} image attachments`,
        detail: q.text + `\n\nImage attachments: ${q.attachments}`,
        actions: [
          { value: "edit", label: "Edit message" },
          { value: "first", label: "Move to front" },
          { value: "remove", label: "Remove message" },
        ],
      }));
    if (kind === "terminals")
      return source.runtime.terminals.list(source.session).map((t) => ({
        id: t.id,
        title: t.command,
        state:
          t.state + (t.exitCode === undefined ? "" : ` · exit ${t.exitCode}`),
        detail: `Command: ${t.command}\nState: ${t.state} · exit code: ${t.exitCode ?? "pending"}\n${t.dropped ? `[${t.dropped} earlier characters omitted]\n` : ""}${t.output || "No output yet."}`,
        actions:
          t.state === "running"
            ? [
                { value: "send", label: "Send a line…" },
                { value: "stop", label: "Stop terminal…" },
              ]
            : [],
      }));
    return source.runtime
      .childTasks(source.session)
      .map((t) => ({
        id: t.id,
        title: t.task,
        state: t.state,
        detail: `Task: ${t.task}\nState: ${t.state}\n\n${t.output || "No text output yet. Refresh to check progress."}`,
        actions: ["running", "starting"].includes(t.state)
          ? [{ value: "stop", label: "Stop child agent…" }]
          : [],
      }));
  };
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
        const all = items(kind);
        page = Math.min(page, Math.max(0, Math.ceil(all.length / 20) - 1));
        const choice = await panel.choose(
          names[kind],
          [
            ...all
              .slice(page * 20, (page + 1) * 20)
              .map((t) => ({
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
            const item = items(kind).find((t) => t.id === choice.value);
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
            const timer = setInterval(() => {
              if (signal.aborted) return;
              const latest = items(kind).find((t) => t.id === item.id);
              if (latest)
                panel.updateDocument(
                  `${names[kind]} · ${latest.state}`,
                  latest.detail,
                );
            }, 250);
            let action;
            try {
              action = await pending;
            } finally {
              clearInterval(timer);
            }
            if (action.value === "back") break;
            if (action.value === "refresh") continue;
            if (action.value === "edit") {
              const current = source.agent
                .pendingPrompts()
                .find((q) => q.id === item.id);
              if (!current) throw Error("Message is no longer queued");
              // Single-line input preserves existing multi-line messages unless explicitly replaced.
              const text = await panel.prompt(
                "Edit pending message",
                false,
                current.text,
                { cancelValue: "" },
              );
              if (!text) continue;
              source.agent.updatePending(item.id, text);
              message = "Message updated; still queued.";
            } else if (action.value === "first") {
              source.agent.prioritizePending(item.id);
              message = "Message moved to front; still queued.";
            } else if (action.value === "remove") {
              if (!(await confirm("Remove pending message?", item.title)))
                continue;
              source.agent.removePending(item.id);
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
              source.runtime.terminals.send(
                source.session,
                item.id,
                text + "\n",
              );
              message =
                "Input sent. Refresh output to verify the program response.";
            } else if (action.value === "stop") {
              if (!(await confirm("Stop this task?", item.title))) continue;
              if (kind === "terminals")
                source.runtime.terminals.stop(source.session, item.id);
              else source.runtime.stopChild(source.session, item.id);
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
    release();
  }
}
