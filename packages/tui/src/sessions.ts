import type { Session } from "../../core/src/types.ts";
import type { HikaroView } from "./index.ts";
export async function openSessions(
  view: HikaroView,
  current: () => string,
  list: (offset: number, limit: number) => Promise<Session[]>,
  resume: (id: string) => Promise<void>,
  remove: (id: string) => Promise<string | undefined>,
  rename?: (id: string, title: string) => Promise<void>,
) {
  const { panel, signal, close } = view.openModelPanel();
  let warning = "",
    offset = 0;
  try {
    for (;;) {
      const rows = await list(offset, 51);
      const sessions = rows.slice(0, 50);
      if (!sessions.length && offset) {
        offset = Math.max(0, offset - 50);
        continue;
      }
      const picked = await panel.choose(
        `Sessions · page ${offset / 50 + 1} · search this page`,
        [
          ...sessions.map((session) => ({
            value: session.id,
            label: `${session.id === current() ? "● " : ""}${session.title}`,
            description: session.id,
          })),
          ...(offset ? [{ value: "__previous", label: "Previous page…" }] : []),
          ...(rows.length > 50
            ? [{ value: "__next", label: "Next page…" }]
            : []),
        ],
        warning,
        `↑↓ select · Enter resume · Delete/Ctrl+D delete${rename ? " · Ctrl+R rename" : ""} · Esc close`,
        {
          allowDelete: true,
          allowRename: !!rename,
          search: true,
          emptyMessage: "No matching sessions on this page",
          enterAction: "resume",
        },
      );
      if (picked.value === "__previous") {
        offset -= 50;
        warning = "";
        continue;
      }
      if (picked.value === "__next") {
        offset += 50;
        warning = "";
        continue;
      }
      try {
        if (picked.action === "delete") {
          const session = sessions.find(
            (session) => session.id === picked.value,
          )!;
          const confirm = await panel.choose(
            `Delete “${session.title}”?`,
            [
              {
                value: "delete",
                label: "Delete session",
                description:
                  "Removes history, tasks and outputs. Branches and workspace files stay.",
              },
            ],
            "",
            "Enter delete · Esc cancel",
            { cancelValue: "__cancel", enterAction: "delete" },
          );
          if (confirm.value !== "delete") continue;
          warning = (await remove(session.id)) ?? "";
        } else if (picked.action === "rename" && rename) {
          const session = sessions.find(
            (session) => session.id === picked.value,
          )!;
          const title = await panel.prompt(
            "Rename session · Enter save · Esc cancel",
            false,
            session.title,
            { cancelValue: "__cancel" },
          );
          if (title !== "__cancel") await rename(session.id, title);
          warning = "";
        } else {
          await resume(picked.value);
          return;
        }
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
      }
    }
  } catch (e) {
    if (!signal.aborted) view.setError(String(e));
  } finally {
    close();
  }
}
