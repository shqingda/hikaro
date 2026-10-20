import type { Agent } from "../../core/src/index.ts";
import type { Runtime } from "./index.ts";
export type ExecutionKind =
  "queue" | "terminals" | "children" | "steering" | "history";
export type ExecutionItem = {
  id: string;
  title: string;
  state: string;
  detail: string;
  editText?: string;
  actions: { value: string; label: string }[];
};
export function executionItems(
  agent: Pick<Agent, "pendingPrompts" | "pendingSteering">,
  runtime: Pick<Runtime, "terminals" | "childTasks">,
  session: string,
  kind: Exclude<ExecutionKind, "history">,
): ExecutionItem[] {
  if (kind === "queue")
    return agent.pendingPrompts().map((q, i) => ({
      id: q.id,
      title: `${i + 1}. ${q.text}`,
      state: `${q.recovered ? "Recovered · confirmation required · " : ""}${q.attachments} image attachments`,
      editText: q.text,
      detail:
        q.text +
        `\n\nImage attachments: ${q.attachments}` +
        (q.recovered
          ? "\nRecovered after interruption. Confirm resume to send; closing this panel will not send it."
          : ""),
      actions: [
        ...(q.recovered
          ? [{ value: "resume", label: "Resume recovered message…" }]
          : []),
        { value: "edit", label: "Edit message" },
        { value: "first", label: "Move to front" },
        { value: "remove", label: "Remove message" },
      ],
    }));
  if (kind === "steering")
    return agent.pendingSteering().map((q, i) => ({
      id: q.id,
      title: `${i + 1}. ${q.text}`,
      state: "Pending next model turn · memory only",
      editText: q.text,
      detail:
        q.text +
        "\n\nApplies to the next model turn. Consumption is paused while this manager is open. Not saved across host restart.",
      actions: [
        { value: "edit", label: "Edit message" },
        { value: "first", label: "Move to front" },
        { value: "remove", label: "Remove message" },
      ],
    }));
  if (kind === "terminals")
    return runtime.terminals.list(session).map((t) => ({
      id: t.id,
      title: t.command,
      state:
        t.state + (t.exitCode === undefined ? "" : ` · exit ${t.exitCode}`),
      detail: `Command: ${t.command}\nState: ${t.state} · exit code: ${t.exitCode ?? "pending"}\nCleanup: ${t.cleanup}${t.exitSignal ? ` · signal ${t.exitSignal}` : ""}${t.stopError ? `\n${t.stopError}` : ""}\n${t.dropped ? `[${t.dropped} earlier characters omitted]\n` : ""}${t.output || "No output yet."}`,
      actions:
        t.state === "running"
          ? [
              { value: "send", label: "Send a line…" },
              { value: "stop", label: "Stop terminal…" },
            ]
          : t.state === "stop_failed"
            ? [{ value: "stop", label: "Retry stop terminal…" }]
            : [],
    }));
  return runtime.childTasks(session).map((t) => ({
    id: t.id,
    title: t.task,
    state: t.state,
    detail: `Task: ${t.task}\nState: ${t.state}\n\n${t.output || "No text output yet. Refresh to check progress."}`,
    actions: ["running", "starting"].includes(t.state)
      ? [{ value: "stop", label: "Stop child agent…" }]
      : [],
  }));
}
