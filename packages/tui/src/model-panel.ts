import { sanitize as clean } from "./text.ts";
import {
  Input,
  SelectList,
  Text,
  CURSOR_MARKER,
  matchesKey,
  isKeyRelease,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
const accent = (v: string) => `\x1b[38;2;196;85;72m${clean(v)}\x1b[39m`;
const dim = (v: string) => `\x1b[90m${clean(v)}\x1b[39m`;
const red = (v: string) => `\x1b[31m${clean(v)}\x1b[39m`;
export type Selection = {
  value: string;
  makeDefault: boolean;
  action?: "delete" | "rename";
  query?: string;
};
type ActionCapability = boolean | ((item: SelectItem) => boolean);
/** The input-adjacent panel owns focus only for its lifetime. Secret input never renders raw bytes. */
export class ModelPanel implements Component {
  focused = false;
  private title = "";
  private document?: {
    text: string;
    width: number;
    lines: string[];
    offset: number;
    height: number;
  };
  private documentReady = true;
  private requireNoticeVisible = false;
  private noticeVisible = true;
  private message = "";
  private error = "";
  private help?: string;
  private allowDelete: ActionCapability = false;
  private allowRename: ActionCapability = false;
  private allowDefault: ActionCapability = false;
  private enterAction: string | ((item: SelectItem) => string) = "confirm";
  private cancelValue?: string;
  private input?: Input;
  private list?: SelectList;
  private items: SelectItem[] = [];
  private matches: SelectItem[] = [];
  private emptyMessage = "No matching options";
  private secret = false;
  private loadItems?: (query: string) => Promise<SelectItem[]>;
  private searchRevision = 0;
  private searching = false;
  get searchQuery() {
    return this.input?.getValue() ?? "";
  }
  setTitle(title: string) {
    this.title = title;
  }
  private pending?: { resolve: (v: any) => void; reject: (e: Error) => void };
  constructor(
    readonly signal: AbortSignal,
    private refresh: () => void,
    private maxRows: (width: number) => number = () => 18,
  ) {
    signal.addEventListener(
      "abort",
      () => {
        this.pending?.reject(new DOMException("Cancelled", "AbortError"));
        this.pending = undefined;
      },
      { once: true },
    );
  }
  choose(
    title: string,
    items: SelectItem[],
    warning = "",
    help?: string,
    options?: {
      allowDelete?: ActionCapability;
      allowRename?: ActionCapability;
      cancelValue?: string;
      search?: boolean;
      selectedValue?: string;
      emptyMessage?: string;
      allowDefault?: ActionCapability;
      enterAction?: string | ((item: SelectItem) => string);
      loadItems?: (query: string) => Promise<SelectItem[]>;
      searchQuery?: string;
      requireNoticeVisible?: boolean;
    },
  ): Promise<Selection> {
    this.signal.throwIfAborted();
    this.searchRevision++;
    this.requireNoticeVisible = options?.requireNoticeVisible ?? false;
    this.noticeVisible = !this.requireNoticeVisible;
    this.loadItems = options?.loadItems;
    this.searching = false;
    this.document = undefined;
    this.title = title;
    this.message = "";
    this.error = warning;
    this.help = help;
    this.allowDelete = options?.allowDelete ?? false;
    this.allowRename = options?.allowRename ?? false;
    this.allowDefault = options?.allowDefault ?? false;
    this.enterAction = options?.enterAction ?? "confirm";
    this.cancelValue = options?.cancelValue;
    this.secret = false;
    this.items = items;
    this.emptyMessage = options?.emptyMessage ?? "No matching options";
    this.input = undefined;
    if (options?.search ?? items.length > 5) {
      this.input = new Input({
        prompt: "> ",
        placeholder: "Search…",
        placeholderStyle: dim,
      });
      this.input.focused = true;
      this.input.setValue(options?.searchQuery ?? "");
    }
    this.updateList(options?.selectedValue);
    this.refresh();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  readDocument(
    title: string,
    text: string,
    canRollback: boolean | SelectItem[],
  ) {
    const pending = this.choose(
      title,
      [
        {
          value: "back",
          label: Array.isArray(canRollback)
            ? "Back to list"
            : "Back to changes",
        },
        ...(Array.isArray(canRollback)
          ? canRollback
          : canRollback
            ? [{ value: "rollback", label: "Roll back this edit…" }]
            : []),
      ],
      "",
      undefined,
      { search: false, cancelValue: "back" },
    );
    this.document = {
      text: clean(text),
      width: 0,
      lines: [],
      offset: 0,
      height: 1,
    };
    this.documentReady = false;
    this.refresh();
    return pending;
  }
  updateDocument(title: string, text: string) {
    const next = clean(text);
    if (!this.document || (this.title === title && this.document.text === next))
      return;
    this.title = title;
    this.document.text = next;
    this.document.width = 0;
    this.refresh();
  }
  private updateList(selectedValue?: string) {
    const query = (this.input?.getValue() ?? "").trim().toLowerCase();
    const matches = this.loadItems
      ? this.items
      : this.items.filter((item) =>
          [item.label, item.description ?? "", item.value].some((text) =>
            clean(text).toLowerCase().includes(query),
          ),
        );
    this.matches = matches;
    this.list = new SelectList(matches, 8, {
      selectedPrefix: accent,
      selectedText: accent,
      description: dim,
      scrollInfo: dim,
      noMatch: () =>
        dim(`  ${this.searching ? "Searching…" : this.emptyMessage}`),
    });
    if (selectedValue !== undefined) {
      const index = matches.findIndex((item) => item.value === selectedValue);
      if (index >= 0) this.list.setSelectedIndex(index);
    }
    this.list.onSelect = (item) => {
      this.resolveSelection({ value: item.value, makeDefault: false });
    };
  }
  private resolveSelection(selection: Selection) {
    if (this.searching) return;
    if (this.loadItems) selection.query = this.searchQuery;
    this.searchRevision++;
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(selection);
  }
  prompt(
    title: string,
    secret = false,
    initial = "",
    options?: { cancelValue?: string },
  ): Promise<string> {
    this.signal.throwIfAborted();
    this.searchRevision++;
    this.loadItems = undefined;
    this.searching = false;
    this.document = undefined;
    this.requireNoticeVisible = false;
    this.title = title;
    this.error = "";
    this.message = "";
    this.secret = secret;
    this.list = undefined;
    this.input = new Input({ prompt: "> " });
    this.input.setValue(initial);
    this.cancelValue = options?.cancelValue;
    this.input.focused = true;
    this.input.onSubmit = (value) => {
      if (!value.trim()) return;
      const p = this.pending;
      this.pending = undefined;
      this.input?.setValue("");
      p?.resolve(value);
    };
    this.refresh();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  cancelPrompt() {
    this.searchRevision++;
    this.pending?.reject(new DOMException("Cancelled", "AbortError"));
    this.pending = undefined;
    this.input?.setValue("");
    this.input = undefined;
    this.list = undefined;
    this.refresh();
  }
  cancelStep() {
    if (!this.pending || this.cancelValue === undefined) return false;
    this.searchRevision++;
    this.pending.resolve(
      this.list
        ? { value: this.cancelValue, makeDefault: false }
        : this.cancelValue,
    );
    this.pending = undefined;
    this.cancelValue = undefined;
    return true;
  }
  progress(text: string) {
    if (!this.pending) {
      this.document = undefined;
      this.title = "";
      this.error = "";
      this.list = undefined;
      this.input = undefined;
    }
    this.message = text;
    this.refresh();
  }
  showError(text: string) {
    this.error = text;
    this.refresh();
  }
  handleInput(data: string) {
    if (!this.pending || isKeyRelease(data)) return;
    if (
      this.requireNoticeVisible &&
      !this.noticeVisible &&
      matchesKey(data, "enter")
    )
      return;
    if (this.document) {
      const doc = this.document;
      if (matchesKey(data, "pageUp"))
        doc.offset = Math.max(0, doc.offset - doc.height);
      else if (matchesKey(data, "pageDown"))
        doc.offset = Math.min(
          Math.max(0, doc.lines.length - doc.height),
          doc.offset + doc.height,
        );
      else if (matchesKey(data, "home")) doc.offset = 0;
      else if (matchesKey(data, "end"))
        doc.offset = Math.max(0, doc.lines.length - doc.height);
      else if (!this.documentReady) return;
      else {
        this.list?.handleInput(data);
        this.refresh();
        return;
      }
      this.refresh();
      return;
    }
    if (
      this.list &&
      (matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "enter"))
    ) {
      this.list.handleInput(data);
    } else if (
      this.list &&
      this.actionEnabled(this.allowDelete) &&
      (matchesKey(data, "delete") || matchesKey(data, "ctrl+d"))
    ) {
      const item = this.list.getSelectedItem();
      if (item) {
        this.resolveSelection({
          value: item.value,
          makeDefault: false,
          action: "delete",
        });
      }
    } else if (
      this.list &&
      this.actionEnabled(this.allowRename) &&
      matchesKey(data, "ctrl+r")
    ) {
      const item = this.list.getSelectedItem();
      if (item) {
        this.resolveSelection({
          value: item.value,
          makeDefault: false,
          action: "rename",
        });
      }
    } else if (
      this.list &&
      this.actionEnabled(this.allowDefault) &&
      matchesKey(data, "ctrl+s")
    ) {
      const item = this.list.getSelectedItem();
      if (item) {
        this.resolveSelection({ value: item.value, makeDefault: true });
      }
    } else {
      const previous = this.input?.getValue();
      this.input?.handleInput(data);
      if (this.list && previous !== this.input?.getValue()) {
        if (this.loadItems) {
          if (!this.searching) void this.searchItems();
        } else this.updateList(this.list.getSelectedItem()?.value);
      }
    }
    this.refresh();
  }
  private async searchItems() {
    const revision = ++this.searchRevision;
    const load = this.loadItems!;
    this.searching = true;
    this.items = [];
    this.updateList();
    for (;;) {
      const query = this.searchQuery;
      try {
        const items = await load(query);
        if (
          this.signal.aborted ||
          revision !== this.searchRevision ||
          !this.pending
        )
          return;
        if (query !== this.searchQuery) continue;
        this.items = items;
        this.error = "";
      } catch (error) {
        if (
          this.signal.aborted ||
          revision !== this.searchRevision ||
          !this.pending
        )
          return;
        if (query !== this.searchQuery) continue;
        this.error = error instanceof Error ? error.message : String(error);
      }
      this.searching = false;
      this.updateList();
      this.refresh();
      return;
    }
  }
  private actionEnabled(capability: ActionCapability) {
    const item = this.list?.getSelectedItem();
    return (
      !!item &&
      (typeof capability === "function" ? capability(item) : capability)
    );
  }
  private helpLines(width: number, compact: boolean) {
    if (!this.list)
      return new Text(
        dim(
          this.pending
            ? "Enter continue · Esc cancel"
            : "Waiting… · Esc cancel",
        ),
        1,
        compact ? 0 : 1,
      ).render(width);
    const item = this.list.getSelectedItem();
    const action =
      typeof this.enterAction === "function"
        ? item
          ? this.enterAction(item)
          : "confirm"
        : this.enterAction;
    const base = compact
      ? `↑↓ · Enter ${action} · Esc`
      : (this.help ?? `↑↓ select · Enter ${action} · Esc cancel`);
    const extras = [
      ...(this.actionEnabled(this.allowDefault)
        ? ["Ctrl+S active + default"]
        : []),
      ...(this.actionEnabled(this.allowDelete) ? ["Del/Ctrl+D delete"] : []),
      ...(this.actionEnabled(this.allowRename) ? ["Ctrl+R rename"] : []),
    ];
    const text = base + (extras.length ? "\n" + extras.join(" · ") : "");
    return new Text(dim(text), 1, compact ? 0 : 1).render(width);
  }
  private choiceRows(width: number, available: number) {
    if (available <= 0) return [];
    if (!this.matches.length)
      return new Text(dim(this.emptyMessage), 1, 0)
        .render(width)
        .slice(0, available);
    const text = (value: string) =>
      clean(value)
        .replace(/[\r\n]+/g, " ")
        .trim();
    const selected = this.list!.getSelectedItem()!.value;
    const index = this.matches.findIndex((item) => item.value === selected);
    const primary = Math.min(
      32,
      Math.max(
        ...this.matches.map((item) => visibleWidth(text(item.label)) + 2),
      ),
    );
    const rows = new Map<number, string[]>();
    const row = (at: number) => {
      if (rows.has(at)) return rows.get(at)!;
      const item = this.matches[at]!;
      const label = text(item.label),
        description = text(item.description ?? "");
      const prefix = item.value === selected ? "→ " : "  ";
      const gap = " ".repeat(Math.max(2, primary - visibleWidth(label)));
      if (visibleWidth(prefix + label + gap + description) <= width) {
        const lines = [
          item.value === selected
            ? accent(prefix + label + (description ? gap + description : ""))
            : prefix + label + (description ? dim(gap + description) : ""),
        ];
        rows.set(at, lines);
        return lines;
      }
      const wrappedLabel = new Text(label, 0, 0).render(Math.max(1, width - 2));
      const lines = wrappedLabel.map(
        (line, part) => (part ? "  " : prefix) + line,
      );
      if (description)
        lines.push(
          ...new Text(description, 0, 0)
            .render(Math.max(1, width - 4))
            .map((line) => "    " + line),
        );
      const styled = lines.map(
        item.value === selected ? accent : (line) => dim(line),
      );
      rows.set(at, styled);
      return styled;
    };
    const room = Math.max(1, available - (this.matches.length > 1 ? 1 : 0));
    if (row(index).length > room) {
      const visible = row(index).slice(0, Math.max(0, available - 1));
      return [
        ...visible,
        dim(truncateToWidth("  … Resize to read more", width, "…")),
      ];
    }
    let start = index,
      end = index + 1,
      used = row(index).length;
    while (
      start > 0 &&
      index - start < 3 &&
      used + row(start - 1).length <= room
    )
      used += row(--start).length;
    while (
      end < this.matches.length &&
      end - start < 8 &&
      used + row(end).length <= room
    )
      used += row(end++).length;
    while (start > 0 && end - start < 8 && used + row(start - 1).length <= room)
      used += row(--start).length;
    const visible: string[] = [];
    for (let at = start; at < end; at++) visible.push(...row(at));
    if (start || end < this.matches.length)
      visible.push(
        dim(
          truncateToWidth(
            `  (${index + 1}/${this.matches.length}) · ↑↓`,
            width,
            "…",
          ),
        ),
      );
    return visible;
  }
  render(width: number) {
    const budget = Math.max(0, Math.floor(this.maxRows(width)));
    this.noticeVisible = false;
    this.documentReady = false;
    if (budget < 4)
      return new Text(dim("Resize terminal · Esc"), 0, 0)
        .render(width)
        .slice(0, budget);
    if (this.document) {
      const doc = this.document;
      const actions = this.choiceRows(
        width,
        Math.min(6, this.matches.length + 1),
      );
      const help = new Text(
        dim("PgUp/PgDn scroll · ↑↓ action · Enter · Esc back"),
        1,
        0,
      ).render(width);
      const height = budget - actions.length - help.length - 2;
      this.documentReady = height >= 2;
      if (!this.documentReady)
        return new Text(dim("Resize to read diff · Esc back"), 0, 0)
          .render(width)
          .slice(0, budget);
      if (doc.width !== width) {
        doc.lines = new Text(doc.text, 1, 0).render(width);
        doc.width = width;
      }
      doc.height = height;
      doc.offset = Math.min(doc.offset, Math.max(0, doc.lines.length - height));
      return [
        accent(truncateToWidth(clean(this.title), width, "…")),
        ...doc.lines.slice(doc.offset, doc.offset + height),
        dim(
          truncateToWidth(
            `Lines ${doc.offset + 1}–${Math.min(doc.offset + height, doc.lines.length)}/${doc.lines.length}`,
            width,
            "…",
          ),
        ),
        ...actions,
        ...help,
      ];
    }
    const compact = width < 72 || budget < 16;
    const title = compact
      ? truncateToWidth(clean(this.title), Math.max(1, width - 2), "…")
      : this.title;
    const lines = new Text(accent(title), 1, compact ? 0 : 1).render(width);
    if (this.input) {
      lines.push(
        ...(this.secret
          ? [
              ` > ${"•".repeat(Math.min(this.input.getValue().length, Math.max(1, width - 5)))}${CURSOR_MARKER}`,
            ]
          : this.input.render(width)),
      );
    }
    const help = this.helpLines(width, compact);
    const message = this.message
      ? new Text(dim(this.message), 1, compact ? 0 : 1).render(width)
      : [];
    const error = this.error
      ? new Text(red(this.error), 1, compact ? 0 : 1).render(width)
      : [];
    if (this.list && this.input) lines.push("");
    if (lines.length + help.length + (this.list ? 1 : 0) > budget)
      return new Text(dim("Resize terminal · Esc close"), 0, 0)
        .render(width)
        .slice(0, budget);
    const noticeRoom = Math.max(
      0,
      budget - lines.length - help.length - (this.list ? 2 : 0),
    );
    if (
      this.requireNoticeVisible &&
      message.length + error.length > noticeRoom
    ) {
      return new Text(
        dim("Resize to read the complete confirmation · Esc cancel"),
        0,
        0,
      )
        .render(width)
        .slice(0, budget);
    }
    this.noticeVisible = true;
    const notices = [...message, ...error].slice(0, noticeRoom);
    if (this.list)
      lines.push(
        ...this.choiceRows(
          width,
          budget - lines.length - help.length - notices.length,
        ),
      );
    lines.push(...notices, ...help);
    return lines;
  }
  invalidate() {
    this.input?.invalidate();
    this.list?.invalidate();
  }
}
