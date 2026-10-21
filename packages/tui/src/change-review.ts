import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { FileChange } from "../../tools/src/changes.ts";
import type { HikaroView } from "./index.ts";

import { changeDiff } from "../../core/src/change-diff.ts";
export { changeDiff } from "../../core/src/change-diff.ts";
export async function openChangeReview(
  view: HikaroView,
  source: {
    cwd: string;
    list(): Promise<FileChange[]>;
    detail(id: string): Promise<{
      entry: FileChange;
      before: string | undefined;
      after: string;
    }>;
    rollback(id: string, signal: AbortSignal): Promise<void>;
    redo?(id: string, signal: AbortSignal): Promise<void>;
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
          entry.state === "reverted" && source.redo
            ? [{ value: "redo", label: "Reapply this edit…" }]
            : entry.state === "committed",
        );
        if (action.value !== "rollback" && action.value !== "redo") continue;
        const redo = action.value === "redo";
        const confirmed = await panel.choose(
          redo ? "Confirm reapply edit" : "Confirm file rollback",
          [
            {
              value: "cancel",
              label: redo ? "Keep current file" : "Keep this change",
            },
            {
              value: "confirm",
              label: redo
                ? "Reapply recorded contents"
                : before === undefined
                  ? "Delete created file"
                  : "Restore previous contents",
            },
          ],
          `${entry.path}\n${redo ? "Reapplies the recorded edit as a new change." : before === undefined ? "Removes this newly created file." : "Restores contents from before this edit."} Later edits cause a conflict and are preserved.`,
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
        panel.progress(redo ? "Reapplying…" : "Rolling back…");
        if (redo) await source.redo!(selected, signal);
        else await source.rollback(selected, signal);
        message = redo
          ? `Reapplied ${path}. A new change was recorded.`
          : `Rolled back ${path}. ${before === undefined ? "Created file removed." : "Previous contents restored."}`;
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
