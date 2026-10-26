import type { HikaroView } from "./index.ts";
import type { MessageSearchPage } from "../../protocol/src/contracts.ts";

export type SearchContent = { data: string; nextOffset: number | null };
/** Both backends forward this as `messages.content` params. */
export type SearchContentRequest = {
  seq: number;
  field: "text";
  offset: number;
  limit: number;
};

/** Same bounded search and reader for local and attached TUI sessions. */
export async function openMessageSearch(
  view: HikaroView,
  query: string,
  search: (query: string, before?: number) => Promise<MessageSearchPage>,
  content: (request: SearchContentRequest) => Promise<SearchContent>,
) {
  const read = async (seq: number, offset: number) => {
    const page = await content({ seq, field: "text", offset, limit: 16000 });
    if (
      typeof page.data !== "string" ||
      (page.nextOffset !== null && page.nextOffset <= offset)
    )
      throw Error("Invalid message page");
    return page;
  };
  const { panel, signal, close } = view.openModelPanel();
  try {
    if (!query.trim())
      query = await panel.prompt(
        "Search messages · Enter search · Esc cancel",
        false,
        "",
        { cancelValue: "__cancel" },
      );
    if (!query.trim() || query === "__cancel") return;
    const cursors: (number | undefined)[] = [undefined];
    let page = 0,
      selected: string | undefined;
    for (;;) {
      panel.progress("Searching message history…");
      const results = await search(query, cursors[page]);
      signal.throwIfAborted();
      const choice = await panel.choose(
        `Search: ${query} · page ${page + 1}`,
        [
          ...results.items.map((item) => ({
            value: String(item.seq),
            label: `${item.role} · #${item.seq}`,
            description: item.snippet,
          })),
          ...(page ? [{ value: "previous", label: "Previous results" }] : []),
          ...(results.nextBefore !== null
            ? [{ value: "next", label: "Older results" }]
            : []),
          { value: "close", label: "Close search" },
        ],
        results.items.length
          ? "Literal text · this session · newest first"
          : "No matching messages in this session",
        undefined,
        {
          search: false,
          cancelValue: "close",
          selectedValue: selected,
          enterAction: "open",
        },
      );
      if (choice.value === "close") return;
      if (choice.value === "previous") {
        page--;
        continue;
      }
      if (choice.value === "next") {
        cursors[++page] = results.nextBefore!;
        continue;
      }
      const item = results.items.find(
        (row) => String(row.seq) === choice.value,
      );
      if (!item) continue;
      selected = choice.value;
      const offsets = [0];
      let section = 0;
      for (;;) {
        panel.progress("Loading message…");
        const content = await read(item.seq, offsets[section]!);
        signal.throwIfAborted();
        const action = await panel.readDocument(
          `${item.role} · #${item.seq} · section ${section + 1}`,
          content.data,
          [
            ...(section
              ? [{ value: "previous", label: "Previous section" }]
              : []),
            ...(content.nextOffset !== null
              ? [{ value: "next", label: "Next section" }]
              : []),
          ],
        );
        if (action.value === "previous") section--;
        else if (action.value === "next")
          offsets[++section] = content.nextOffset!;
        else break;
      }
    }
  } finally {
    close();
  }
}
