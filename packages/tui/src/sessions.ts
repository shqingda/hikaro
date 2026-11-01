import type { Session } from "../../core/src/types.ts";
import type { HikaroView } from "./index.ts";
import { errorMessage } from "../../core/src/util.ts";

/** What each TUI mode supplies; local guards and host epochs stay inside these calls. */
export type SessionBackend = {
  current(): string;
  listAll?(offset: number, limit: number, query?: string): Promise<Session[]>;
  list(offset: number, limit: number, query?: string): Promise<Session[]>;
  /** Persist the visible draft before the view leaves this session. */
  flush(): Promise<void>;
  open(id: string): Promise<void>;
  /** Replaces the view's session after the current one was deleted. */
  create(): Promise<void>;
  remove(id: string): Promise<string | undefined>;
  rename?(id: string, title: string): Promise<void>;
};

function sessionDay(createdAt: number) {
  const start = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round(
    (start(new Date()) - start(new Date(createdAt))) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

/** `/sessions [QUERY]` and `/resume [ID]` for local and attached TUI sessions. */
export async function sessionCommand(
  view: HikaroView,
  command: "sessions" | "resume" | "delete",
  arg: string,
  backend: SessionBackend,
) {
  const open = async (id: string) => {
    await backend.flush();
    await backend.open(id);
  };
  if (command === "resume" && arg) return open(arg);
  await openSessions(
    view,
    () => backend.current(),
    (offset, limit, query) => backend.list(offset, limit, query),
    open,
    async (id) => {
      await backend.flush();
      const current = id === backend.current();
      const cleanupError = await backend.remove(id);
      if (current) await backend.create();
      return cleanupError;
    },
    backend.rename && ((id, title) => backend.rename!(id, title)),
    command === "sessions" || command === "delete" ? arg : "",
    { listAll: backend.listAll, deleting: command === "delete" },
  );
}

export async function openSessions(
  view: HikaroView,
  current: () => string,
  list: (offset: number, limit: number, query?: string) => Promise<Session[]>,
  resume: (id: string) => Promise<void>,
  remove: (id: string) => Promise<string | undefined>,
  rename?: (id: string, title: string) => Promise<void>,
  initialQuery = "",
  options: { listAll?: SessionBackend["listAll"]; deleting?: boolean } = {},
) {
  const { panel, signal, close } = view.openModelPanel();
  let allProjects = false;
  const load = (offset: number, limit: number, query: string) =>
    allProjects && options.listAll
      ? options.listAll(offset, limit, query)
      : list(offset, limit, query);
  // The tabs already name the scope, so the title only carries the page.
  const title = () => (options.deleting ? "Delete session" : "Sessions");
  let warning = "",
    offset = 0,
    query = initialQuery;
  try {
    for (;;) {
      panel.progress("Loading sessions…");
      let rows = await load(offset, 51, query);
      let sessions = rows.slice(0, 50);
      if (!sessions.length && offset) {
        offset = Math.max(0, offset - 50);
        continue;
      }
      const choices = () => [
        ...sessions.map((session) => ({
          value: session.id,
          label: session.title,
          section: sessionDay(session.createdAt),
        })),
        ...(offset ? [{ value: "__previous", label: "Previous page…" }] : []),
        ...(rows.length > 50 ? [{ value: "__next", label: "Next page…" }] : []),
      ];
      const picked = await panel.choose(
        `${title()} · page ${offset / 50 + 1}`,
        choices(),
        warning,
        undefined,
        {
          ...(options.listAll
            ? {
                tabs: [
                  { value: "current", label: "This project" },
                  { value: "all", label: "All projects" },
                ],
                activeTab: allProjects ? "all" : "current",
              }
            : {}),
          allowDelete: (item) =>
            sessions.some((session) => session.id === item.value),
          allowRename: (item) =>
            !!rename && sessions.some((session) => session.id === item.value),
          search: true,
          searchQuery: query,
          loadItems: async (text) => {
            const found = await load(0, 51, text);
            if (signal.aborted || text !== panel.searchQuery) return [];
            offset = 0;
            panel.setTitle(`${title()} · page 1`);
            rows = found;
            sessions = rows.slice(0, 50);
            return choices();
          },
          emptyMessage: allProjects
            ? "No matching sessions"
            : "No matching sessions in this project",
          enterAction: (item) =>
            item.value === "__previous"
              ? "previous page"
              : item.value === "__next"
                ? "next page"
                : options.deleting
                  ? "delete"
                  : "resume",
        },
      );
      query = picked.query ?? query;
      if (picked.action === "scope" || picked.action === "tab") {
        allProjects =
          picked.action === "scope" ? !allProjects : picked.value === "all";
        offset = 0;
        continue;
      }
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
        if (picked.action === "delete" || options.deleting) {
          const session = sessions.find(
            (session) => session.id === picked.value,
          )!;
          const confirm = await panel.choose(
            `Delete “${session.title}”?`,
            [
              { value: "__cancel", label: "Keep session" },
              {
                value: "delete",
                label: "Delete session",
              },
            ],
            "",
            "Choose an action · Esc cancel",
            {
              cancelValue: "__cancel",
              enterAction: "confirm",
              requireNoticeVisible: true,
              description:
                "Removes session history, tasks and outputs. Workspace files stay.",
            },
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
        warning = errorMessage(e);
      }
    }
  } catch (e) {
    if (!signal.aborted) view.setError(String(e));
  } finally {
    close();
  }
}
