import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { FileChange } from "../../tools/src/changes.ts";
import type { HikaroView } from "./index.ts";

/** One exact replacement hunk; common prefix/suffix stay out of large previews. */
export function changeDiff(
  path: string,
  before: string | undefined,
  after: string,
) {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const old = lines(before ?? "");
  const next = lines(after);
  const display = (prefix: string, line: string) =>
    line.endsWith("\n")
      ? prefix + line.slice(0, -1)
      : prefix + line + "\n\\ No newline at end of file";
  let start = 0,
    end = 0;
  while (
    start < old.length &&
    start < next.length &&
    old[start] === next[start]
  )
    start++;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - 3);
  const oldEnd = Math.min(old.length, old.length - end + 3);
  const newEnd = Math.min(next.length, next.length - end + 3);
  return [
    `--- ${before === undefined ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ -${oldEnd === from ? from : from + 1},${oldEnd - from} +${newEnd === from ? from : from + 1},${newEnd - from} @@`,
    ...old.slice(from, start).map((line) => display(" ", line)),
    ...old.slice(start, old.length - end).map((line) => display("-", line)),
    ...next.slice(start, next.length - end).map((line) => display("+", line)),
    ...next.slice(next.length - end, newEnd).map((line) => display(" ", line)),
  ].join("\n");
}
export async function openChangeReview(
  view: HikaroView,
  source: {
    cwd: string;
    list(): Promise<FileChange[]>;
    detail(
      id: string,
    ): Promise<{
      entry: FileChange;
      before: string | undefined;
      after: string;
    }>;
    rollback(id: string, signal: AbortSignal): Promise<void>;
  },
) {
  const cwd = await realpath(source.cwd);
  const { panel, signal, close } = view.openModelPanel();
  let page = 0,
    selected: string | undefined,
    message = "";
  try {
    for (;;) {
      const entries = await source.list();
      signal.throwIfAborted();
      page = Math.min(page, Math.max(0, Math.ceil(entries.length / 20) - 1));
      const items = entries.slice(page * 20, (page + 1) * 20).map((entry) => ({
        value: entry.id,
        label: relative(cwd, entry.path) || entry.path,
        description: `${entry.before === null ? "Created" : "Edited"} · ${entry.state} · ${new Date(entry.timestamp).toLocaleTimeString()}`,
      }));
      if (page)
        items.push({
          value: "previous",
          label: "Previous page",
          description: "Newer changes",
        });
      if ((page + 1) * 20 < entries.length)
        items.push({
          value: "next",
          label: "Next page",
          description: "Older changes",
        });
      items.push({
        value: "close",
        label: "Close",
        description: "Return to conversation",
      });
      const choice = await panel.choose(
        `File changes · page ${page + 1}`,
        items,
        message ||
          (entries.length
            ? "Recorded file-tool edits only. Shell, plugins and other sessions are not covered. Undo newest edits first."
            : "No recorded file edits in this session. Shell/plugin changes and edits from before this version are not captured."),
        undefined,
        { search: false, selectedValue: selected, enterAction: "open" },
      );
      if (choice.value === "close") return;
      if (choice.value === "next") {
        page++;
        continue;
      }
      if (choice.value === "previous") {
        page--;
        continue;
      }
      selected = choice.value;
      try {
        const { entry, before, after } = await source.detail(selected);
        signal.throwIfAborted();
        const path = relative(cwd, entry.path) || entry.path;
        const action = await panel.readDocument(
          `${path} · ${entry.state}`,
          changeDiff(path, before, after),
          entry.state === "committed",
        );
        if (action.value !== "rollback") continue;
        const confirmed = await panel.choose(
          "Confirm file rollback",
          [
            { value: "cancel", label: "Keep this change" },
            {
              value: "confirm",
              label:
                before === undefined
                  ? "Delete created file"
                  : "Restore previous contents",
            },
          ],
          `${entry.path}\n${before === undefined ? "Removes this newly created file." : "Restores contents from before this edit."} Later edits cause a conflict and are preserved.`,
          undefined,
          {
            search: false,
            cancelValue: "cancel",
            selectedValue: "cancel",
            enterAction: "confirm",
            requireNoticeVisible: true,
          },
        );
        if (confirmed.value !== "confirm") continue;
        panel.progress("Rolling back…");
        await source.rollback(selected, signal);
        message = `Rolled back ${path}. ${before === undefined ? "Created file removed." : "Previous contents restored."}`;
        view.notice(message);
      } catch (error) {
        if (signal.aborted) throw error;
        message = error instanceof Error ? error.message : String(error);
        view.setError(message);
      }
    }
  } catch (error) {
    if (!signal.aborted)
      view.setError(error instanceof Error ? error.message : String(error));
  } finally {
    close();
  }
}
