import { sanitize as clean } from "./text.ts";
import {
  Input,
  Text,
  CURSOR_MARKER,
  matchesKey,
  isKeyRelease,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "./primitives.ts";
import { accent, muted as dim, selected, error as red } from "./theme.ts";
export type Selection = {
  value: string;
  makeDefault: boolean;
  action?: string;
  query?: string;
};
export type PanelItem = SelectItem & {
  section?: string;
  detail?: string;
  searchText?: string;
};
type ActionCapability = boolean | ((item: PanelItem) => boolean);
export type PanelAction = {
  id: string;
  key: Parameters<typeof matchesKey>[1];
  label: string | ((item: PanelItem | undefined) => string);
  enabled?: ActionCapability;
};

/** Selection state belongs to Hikaro; the editor still owns text input. */
class MenuSelection {
  private index = 0;
  onSelect?: (item: SelectItem) => void;
  constructor(private items: PanelItem[]) {}
  setSelectedIndex(index: number) {
    this.index = Math.max(0, Math.min(index, this.items.length - 1));
  }
  getSelectedItem() {
    return this.items[this.index];
  }
  handleInput(data: string) {
    if (!this.items.length) return;
    if (matchesKey(data, "up"))
      this.index = (this.index + this.items.length - 1) % this.items.length;
    else if (matchesKey(data, "down"))
      this.index = (this.index + 1) % this.items.length;
    else if (matchesKey(data, "enter"))
      this.onSelect?.(this.items[this.index]!);
  }
}
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
    lineOffsets: number[];
    query: string;
    find: Input;
    searching: boolean;
    matches: number[];
    match: number;
  };
  private documentReady = true;
  private requireNoticeVisible = false;
  private noticeVisible = true;
  private message = "";
  private error = "";
  private help?: string;
  private actions: PanelAction[] = [];
  private tabs: Array<{ value: string; label: string }> = [];
  private activeTab?: string;
  private allowDelete: ActionCapability = false;
  private allowRename: ActionCapability = false;
  private allowDefault: ActionCapability = false;
  private enterAction: string | ((item: SelectItem) => string) = "confirm";
  private cancelValue?: string;
  private input?: Input;
  private onInputChange?: (value: string) => void;
  private list?: MenuSelection;
  private descriptionOffset = 0;
  private descriptionHeight = 1;
  private descriptionRows = 0;
  private items: PanelItem[] = [];
  private matches: PanelItem[] = [];
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
        this.input?.setValue("");
        this.input = undefined;
        this.list = undefined;
      },
      { once: true },
    );
  }
  choose(
    title: string,
    items: PanelItem[],
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
      actions?: PanelAction[];
      tabs?: Array<{ value: string; label: string }>;
      activeTab?: string;
      description?: string;
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
    this.message = options?.description ?? "";
    this.error = warning;
    this.help = help;
    this.actions = options?.actions ?? [];
    this.tabs = options?.tabs ?? [];
    this.activeTab = options?.activeTab;
    this.allowDelete = options?.allowDelete ?? false;
    this.allowRename = options?.allowRename ?? false;
    this.allowDefault = options?.allowDefault ?? false;
    this.enterAction = options?.enterAction ?? "confirm";
    this.cancelValue = options?.cancelValue;
    this.secret = false;
    this.items = items;
    this.emptyMessage = options?.emptyMessage ?? "No matching options";
    this.input = undefined;
    this.onInputChange = undefined;
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
          label:
            Array.isArray(canRollback) &&
            !canRollback.some((item) => item.value === "rollback")
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
      text: clean(text).replace(/\t/g, "   "),
      width: 0,
      lines: [],
      offset: 0,
      height: 1,
      lineOffsets: [],
      query: "",
      find: new Input({
        prompt: "/ ",
        placeholder: "Find in this part…",
        placeholderStyle: dim,
      }),
      searching: false,
      matches: [],
      match: 0,
    };
    this.documentReady = false;
    this.refresh();
    return pending;
  }
  updateDocument(title: string, text: string) {
    const next = clean(text).replace(/\t/g, "   ");
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
          [
            item.label,
            item.description ?? "",
            item.searchText ?? "",
            item.value,
          ].some((text) => clean(text).toLowerCase().includes(query)),
        );
    this.matches = matches;
    this.list = new MenuSelection(matches);
    this.descriptionOffset = 0;
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
    if (this.input) selection.query = this.searchQuery;
    this.searchRevision++;
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(selection);
  }
  prompt(
    title: string,
    secret = false,
    initial = "",
    options?: { cancelValue?: string; onChange?: (value: string) => void },
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
    this.tabs = [];
    this.actions = [];
    this.onInputChange = secret ? undefined : options?.onChange;
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
    this.onInputChange = undefined;
    this.list = undefined;
    this.refresh();
  }
  cancelStep() {
    if (this.document?.searching) {
      this.document.searching = false;
      this.document.find.focused = false;
      this.refresh();
      return true;
    }
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
    if (this.signal.aborted) return;
    if (!this.pending) {
      this.document = undefined;
      this.title = "";
      this.error = "";
      this.list = undefined;
      this.input = undefined;
      this.onInputChange = undefined;
      this.tabs = [];
      this.actions = [];
    }
    this.message = text;
    this.refresh();
  }
  showError(text: string) {
    if (this.signal.aborted) return;
    this.error = text;
    this.refresh();
  }
  handleInput(data: string) {
    if (!this.pending || isKeyRelease(data)) return;
    if (
      this.tabs.length > 1 &&
      (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
    ) {
      const index = this.tabs.findIndex((tab) => tab.value === this.activeTab);
      const offset = matchesKey(data, "shift+tab") ? -1 : 1;
      const next =
        this.tabs[(index + offset + this.tabs.length) % this.tabs.length]!;
      this.resolveSelection({
        value: next.value,
        makeDefault: false,
        action: "tab",
      });
      return;
    }
    const action = this.actions.find(
      (item) =>
        matchesKey(data, item.key) &&
        (item.enabled === undefined || this.actionEnabled(item.enabled)),
    );
    if (action) {
      this.resolveSelection({
        value: this.list?.getSelectedItem()?.value ?? "",
        makeDefault: false,
        action: action.id,
      });
      return;
    }
    if (
      this.requireNoticeVisible &&
      !this.noticeVisible &&
      matchesKey(data, "enter")
    )
      return;
    if (this.document) {
      const doc = this.document;
      if (doc.searching) {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          doc.searching = false;
          doc.find.focused = false;
        } else {
          doc.find.handleInput(data);
          doc.query = doc.find.getValue();
          this.findInDocument(true);
        }
        this.refresh();
        return;
      }
      if (data === "/" || matchesKey(data, "ctrl+f")) {
        doc.searching = true;
        doc.find.focused = this.focused;
      } else if ((data === "n" || data === "N") && doc.query) {
        if (doc.matches.length) {
          doc.match =
            (doc.match + (data === "n" ? 1 : doc.matches.length - 1)) %
            doc.matches.length;
          doc.offset = Math.max(0, doc.matches[doc.match]! - 1);
        }
      } else if (matchesKey(data, "pageUp"))
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
      (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
    ) {
      const delta = matchesKey(data, "pageUp")
        ? -this.descriptionHeight
        : this.descriptionHeight;
      this.descriptionOffset = Math.max(
        0,
        Math.min(
          Math.max(0, this.descriptionRows - this.descriptionHeight),
          this.descriptionOffset + delta,
        ),
      );
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
      this.descriptionOffset = 0;
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
      // Submission clears the input internally; that is not a draft edit.
      if (
        this.pending &&
        !this.secret &&
        this.input &&
        previous !== this.input.getValue()
      )
        this.onInputChange?.(this.input.getValue());
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
  private findInDocument(reset: boolean) {
    const doc = this.document!;
    const text = doc.text.toLowerCase(),
      query = doc.query.toLowerCase();
    doc.matches = [];
    if (query) {
      let row = 0;
      for (
        let at = text.indexOf(query);
        at >= 0;
        at = text.indexOf(query, at + query.length)
      ) {
        while (
          row + 1 < doc.lineOffsets.length &&
          doc.lineOffsets[row + 1]! <= at
        )
          row++;
        doc.matches.push(row);
      }
    }
    doc.match = reset
      ? 0
      : Math.min(doc.match, Math.max(0, doc.matches.length - 1));
    if (reset && doc.matches.length)
      doc.offset = Math.max(0, doc.matches[doc.match]! - 1);
  }
  private layoutDocument(width: number) {
    const doc = this.document!;
    if (doc.width === width) return;
    doc.lines = new Text(doc.text, 1, 0).render(width);
    const padding = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
    let cursor = 0;
    // Match against original text so a search can cross terminal soft wraps.
    doc.lineOffsets = doc.lines.map((line) => {
      const content = line.slice(padding).trimEnd();
      const start = content ? doc.text.indexOf(content, cursor) : cursor;
      const offset = start < 0 ? cursor : start;
      cursor = offset + content.length;
      return offset;
    });
    doc.width = width;
    this.findInDocument(false);
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
        0,
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
      ...(this.tabs.length > 1 ? ["Tab page"] : []),
      ...this.actions
        .filter(
          (action) =>
            action.enabled === undefined || this.actionEnabled(action.enabled),
        )
        .map(
          (action) =>
            `${action.key.replace("ctrl+", "Ctrl+")} ${typeof action.label === "function" ? action.label(item) : action.label}`,
        ),
      ...(this.actionEnabled(this.allowDefault)
        ? ["Ctrl+S active + default"]
        : []),
      ...(this.actionEnabled(this.allowDelete) ? ["Del/Ctrl+D delete"] : []),
      ...(this.actionEnabled(this.allowRename) ? ["Ctrl+R rename"] : []),
    ];
    const text = base + (extras.length ? "\n" + extras.join(" · ") : "");
    return new Text(dim(clean(text)), 1, 0).render(width);
  }
  private choiceRows(width: number, available: number) {
    if (available <= 0) return [];
    if (!this.matches.length)
      return new Text(
        dim(this.searching ? "Searching…" : clean(this.emptyMessage)),
        1,
        0,
      )
        .render(width)
        .slice(0, available);
    const current = this.list!.getSelectedItem()!;
    const index = this.matches.indexOf(current);
    let count = Math.min(
      8,
      this.matches.length,
      Math.max(1, available - (this.matches.length > available ? 1 : 0)),
    );
    let start = Math.max(
      0,
      Math.min(index - Math.floor(count / 2), this.matches.length - count),
    );
    const text = (value: string) =>
      clean(value)
        .replace(/[\r\n]+/g, " ")
        .trim();
    const sectionCount = () =>
      this.matches
        .slice(start, start + count)
        .filter(
          (item, i, items) =>
            item.section && (i === 0 || items[i - 1]?.section !== item.section),
        ).length;
    while (count > 1 && count + sectionCount() > available) {
      count--;
      start = Math.max(
        0,
        Math.min(index - Math.floor(count / 2), this.matches.length - count),
      );
    }
    const rows: string[] = [];
    const showSections = count + sectionCount() <= available;
    let previousSection: string | undefined;
    for (const item of this.matches.slice(start, start + count)) {
      if (item.section && item.section !== previousSection && showSections)
        rows.push(dim(truncateToWidth(` ${item.section}`, width, "…")));
      previousSection = item.section;
      const label = text(item.label);
      const description = text(item.description ?? "");
      const prefix = item === current ? "→ " : "  ";
      const inline =
        width >= 72 &&
        description &&
        visibleWidth(prefix + label + "  " + description) <= width - 2
          ? "  " + description
          : "";
      const row = truncateToWidth(
        prefix + label + inline,
        Math.max(1, width - 2),
        "…",
      );
      rows.push(" " + (item === current ? selected(row) : row));
    }
    if (
      (start || start + count < this.matches.length) &&
      rows.length < available
    )
      rows.push(
        dim(
          truncateToWidth(
            `  ${index + 1}/${this.matches.length} · ↑↓`,
            width,
            "…",
          ),
        ),
      );
    return rows;
  }
  private descriptionLines(width: number) {
    const item = this.list?.getSelectedItem();
    if (!item) return [];
    const label = clean(item.label);
    const description = clean(item.detail ?? item.description ?? "");
    const text = [visibleWidth(label) > width - 4 ? label : "", description]
      .filter(Boolean)
      .join("\n");
    return text ? new Text(dim(text), 1, 0).render(width) : [];
  }
  private renderDescription(lines: string[], available: number, width: number) {
    this.descriptionRows = lines.length;
    if (!lines.length || available < 1) return [];
    const paged = lines.length > available;
    this.descriptionHeight = Math.max(1, available - (paged ? 1 : 0));
    this.descriptionOffset = Math.min(
      this.descriptionOffset,
      Math.max(0, lines.length - this.descriptionHeight),
    );
    const visible = lines.slice(
      this.descriptionOffset,
      this.descriptionOffset + this.descriptionHeight,
    );
    if (paged && available > 1)
      visible.push(
        dim(
          truncateToWidth(
            ` Details ${this.descriptionOffset + 1}–${this.descriptionOffset + visible.length}/${lines.length} · PgUp/PgDn`,
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
      this.layoutDocument(width);
      doc.find.focused = this.focused && doc.searching;
      const search = doc.searching ? doc.find.render(width) : [];
      const actions = this.choiceRows(
        width,
        Math.min(6, this.matches.length + 1),
      );
      const help = new Text(
        dim(
          doc.searching
            ? "Enter finish search · Esc cancel search"
            : "PgUp/PgDn read · / find · n/N match · ↑↓ action · Enter · Esc",
        ),
        1,
        0,
      ).render(width);
      const height = budget - actions.length - help.length - search.length - 2;
      this.documentReady = height >= 2;
      if (!this.documentReady)
        return new Text(dim("Resize to read diff · Esc back"), 0, 0)
          .render(width)
          .slice(0, budget);
      doc.height = height;
      doc.offset = Math.min(doc.offset, Math.max(0, doc.lines.length - height));
      return [
        accent(truncateToWidth(clean(this.title), width, "…")),
        ...search,
        ...doc.lines
          .slice(doc.offset, doc.offset + height)
          .map((line, index) =>
            doc.query && doc.matches[doc.match] === doc.offset + index
              ? accent(line)
              : line,
          ),
        dim(
          truncateToWidth(
            doc.query
              ? `${doc.matches.length ? `Match ${doc.match + 1}/${doc.matches.length}` : "No matches"} · n/N · ${clean(doc.query)}`
              : `Lines ${doc.offset + 1}–${Math.min(doc.offset + height, doc.lines.length)}/${doc.lines.length}`,
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
    const lines = new Text(accent(clean(title)), 1, 0).render(width);
    if (this.tabs.length)
      lines.push(
        truncateToWidth(
          this.tabs
            .map((tab) =>
              tab.value === this.activeTab ? `[${tab.label}]` : tab.label,
            )
            .join("  "),
          width,
          "…",
        ),
      );
    const titleRows = lines.length;
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
      ? new Text(dim(clean(this.message)), 1, 0).render(width)
      : [];
    const error = this.error
      ? new Text(red(clean(this.error)), 1, 0).render(width)
      : [];
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
    // Notices follow the title; confirmation notices must fit in full.
    lines.splice(titleRows, 0, ...notices);
    if (this.list) {
      const available = budget - lines.length - help.length;
      const description = this.descriptionLines(width);
      const detailBudget = description.length
        ? Math.min(
            description.length + 1,
            Math.max(0, available - 1),
            Math.max(2, Math.floor(available / 2)),
          )
        : 0;
      const choices = this.choiceRows(width, available - detailBudget);
      lines.push(
        ...choices,
        ...this.renderDescription(
          description,
          available - choices.length,
          width,
        ),
      );
    }
    lines.push(...help);
    return lines;
  }
  invalidate() {
    this.input?.invalidate();
  }
}
