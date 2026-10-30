import {
  HStack,
  VStack,
  ScrollView,
  Text,
  Input,
  CURSOR_MARKER,
  FAKE_CURSOR_START,
  FAKE_CURSOR_END,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "./primitives.ts";
import { accent, muted, selected, error as errorText } from "./theme.ts";
import { sanitize } from "./text.ts";

export type ObjectAction = {
  id: string;
  title: string;
  run(): Promise<void> | void;
};
export type WorkspaceObject = {
  id: string;
  title: string;
  description?: string;
  group?: string;
};
export type ObjectDetail = {
  title: string;
  text: string;
  actions?: ObjectAction[];
};
export type ObjectSource = {
  title: string;
  description: string;
  load(signal: AbortSignal): Promise<WorkspaceObject[]>;
  detail(item: WorkspaceObject, signal: AbortSignal): Promise<ObjectDetail>;
  actions?: ObjectAction[];
};

/** Master/detail reader. Loading and selection have separate generations. */
export class ObjectPage extends VStack {
  focused = false;
  readonly search = new Input();
  private items: WorkspaceObject[] = [];
  private matches: WorkspaceObject[] = [];
  private index = 0;
  private chosen?: string;
  private detail?: ObjectDetail;
  private reading = false;
  private searching = false;
  private message = "Loading…";
  private failure = false;
  private loadController?: AbortController;
  private detailController?: AbortController;
  private disposed = false;
  private acting = false;
  private refreshRequested = false;
  private detailBody = new Text(
    "Select an item to inspect its contents.",
    1,
    0,
  );
  private detailScroll = new ScrollView(this.detailBody, {
    follow: "none",
    scrollbar: "auto",
  });
  private actionIndex = 0;
  private renderedRows: { row: number; index: number }[] = [];
  private actionRows: { row: number; action: ObjectAction }[] = [];
  private detailsVisible?: (visible: boolean) => void;

  constructor(
    readonly source: ObjectSource,
    private tui: TUI,
    onDetails?: (visible: boolean) => void,
  ) {
    super();
    this.detailsVisible = onDetails;
    const heading: Component = {
      render: (width) => {
        this.search.focused = this.focused && this.searching;
        return [
          accent(truncateToWidth(` ${source.title}`, width)),
          ...(tui.terminal.rows >= 18 || this.failure
            ? [
                muted(
                  truncateToWidth(
                    ` ${this.message || source.description}`,
                    width,
                  ),
                ),
              ]
            : []),
          ...(this.searching || this.search.getValue()
            ? this.search
                .render(width)
                .map((line) =>
                  this.search.focused
                    ? line
                    : line
                        .replaceAll(CURSOR_MARKER, "")
                        .replaceAll(FAKE_CURSOR_START, "")
                        .replaceAll(FAKE_CURSOR_END, ""),
                )
            : []),
        ];
      },
      invalidate() {},
    };
    const list: Component = {
      render: (width) => {
        this.renderedRows = [];
        const budget = Math.max(1, tui.terminal.rows - 13);
        const start = Math.max(
          0,
          Math.min(
            this.index - Math.floor(budget / 2),
            this.matches.length - budget,
          ),
        );
        const lines: string[] = [];
        for (const [offset, item] of this.matches
          .slice(start, start + budget)
          .entries()) {
          this.renderedRows.push({ row: lines.length, index: start + offset });
          const value = truncateToWidth(
            sanitize(
              ` ${start + offset === this.index ? "›" : " "} ${item.group ? item.group + " · " : ""}${item.title}`,
            ),
            width,
          );
          lines.push(start + offset === this.index ? selected(value) : value);
        }
        if (!lines.length)
          lines.push(
            (this.failure ? errorText : muted)(
              truncateToWidth(` ${this.message || "No matching items"}`, width),
            ),
          );
        return lines;
      },
      invalidate() {},
      handleMouse: (event) => {
        if (event.type === "wheel") {
          this.move(Math.sign(event.wheelDelta ?? 0));
          return { handled: true };
        }
        if (event.type !== "press" || event.button !== "left") return;
        const row = this.renderedRows.find((row) => row.row === event.y);
        if (row) {
          this.index = row.index;
          void this.inspect();
        }
        tui.setFocus(this);
        return { handled: true };
      },
    };
    const actions: Component = {
      render: (width) => {
        this.actionRows = [];
        const available = this.currentActions();
        const lines: string[] = [];
        const i = Math.min(this.actionIndex, Math.max(0, available.length - 1));
        const action = available[i];
        if (action) {
          this.actionRows.push({ row: lines.length, action });
          const line = truncateToWidth(
            ` ${i + 1}/${available.length} ${action.title}${available.length > 1 ? " · Tab next" : ""}`,
            width,
          );
          lines.push(
            i === this.actionIndex && this.reading
              ? selected(line)
              : accent(line),
          );
        }
        return lines;
      },
      invalidate() {},
      handleMouse: (event) => {
        if (event.type !== "press" || event.button !== "left") return;
        const row = this.actionRows.find((row) => row.row === event.y);
        if (row) void this.run(row.action);
        return { handled: true };
      },
    };
    const inspector = new VStack([
      { component: this.detailScroll, basis: 0, grow: 1, minSize: 1 },
      { component: actions, shrink: 0 },
    ]);
    this.addChild(heading, { shrink: 0 });
    this.addChild(
      new HStack(
        [
          {
            component: list,
            basis: 0,
            grow: 1,
            minSize: 1,
            visible: () => !this.reading || tui.terminal.columns >= 100,
          },
          {
            component: inspector,
            basis: 44,
            grow: 0,
            shrink: 0,
            visible: () => this.reading && tui.terminal.columns >= 100,
          },
          {
            component: inspector,
            basis: 0,
            grow: 1,
            minSize: 1,
            visible: () => this.reading && tui.terminal.columns < 100,
          },
        ],
        { gap: 1 },
      ),
      { basis: 0, grow: 1, minSize: 1 },
    );
    this.addChild(actions, { shrink: 0, visible: () => !this.reading });
    this.addChild(
      {
        render: (width) => [
          muted(
            truncateToWidth(
              this.reading
                ? " ← list · PgUp/PgDn read · Tab action · Enter apply · / search"
                : " ↑↓ select · Enter inspect · / search · Ctrl+R refresh · F6 input",
              width,
            ),
          ),
        ],
        invalidate() {},
      },
      { shrink: 0 },
    );
    this.search.onSubmit = () => {
      this.searching = false;
      this.search.invalidate();
      tui.requestRender();
    };
  }
  get inspecting() {
    return this.reading;
  }
  get searchActive() {
    return this.searching;
  }
  async open(id: string) {
    if (!this.items.some((item) => item.id === id)) await this.refresh();
    this.search.setValue("");
    this.filter();
    const index = this.matches.findIndex((item) => item.id === id);
    if (index < 0)
      throw Error("Item is no longer available; refresh the workspace");
    this.index = index;
    await this.inspect();
  }
  private currentActions() {
    return [
      ...(this.reading ? (this.detail?.actions ?? []) : []),
      ...(this.source.actions ?? []),
    ].slice(0, 9);
  }
  private filter() {
    const words = this.search
      .getValue()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    this.matches = this.items.filter((item) =>
      words.every((word) =>
        `${item.title} ${item.description ?? ""} ${item.group ?? ""}`
          .toLowerCase()
          .includes(word),
      ),
    );
    this.index = Math.max(
      0,
      this.matches.findIndex((item) => item.id === this.chosen),
    );
  }
  async refresh() {
    if (this.disposed) return;
    if (this.acting) {
      this.refreshRequested = true;
      return;
    }
    this.loadController?.abort();
    const controller = (this.loadController = new AbortController());
    this.message = "Loading…";
    this.failure = false;
    this.tui.requestRender();
    try {
      const items = await this.source.load(controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      this.items = items;
      this.filter();
      this.message = items.length
        ? this.source.description
        : "No items in this session";
      if (
        this.reading &&
        this.chosen &&
        this.matches.some((item) => item.id === this.chosen)
      )
        await this.inspect(false);
      else if (this.reading) this.closeDetails();
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      this.failure = true;
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }
  private move(delta: number) {
    this.index = Math.max(
      0,
      Math.min(this.matches.length - 1, this.index + delta),
    );
    this.chosen = this.matches[this.index]?.id;
    this.tui.requestRender();
  }
  async inspect(reset = true) {
    const item = this.matches[this.index];
    if (!item) return;
    const selectedAction = !reset
      ? this.currentActions()[this.actionIndex]?.id
      : undefined;
    this.chosen = item.id;
    this.detailController?.abort();
    const controller = (this.detailController = new AbortController());
    this.reading = true;
    this.detail = undefined;
    this.detailsVisible?.(true);
    this.detailBody.setText("Loading details…");
    this.tui.requestRender();
    try {
      const detail = await this.source.detail(item, controller.signal);
      if (controller.signal.aborted || this.disposed || this.chosen !== item.id)
        return;
      this.detail = detail;
      this.actionIndex = Math.max(
        0,
        this.currentActions().findIndex(
          (action) => action.id === selectedAction,
        ),
      );
      this.detailBody.setText(
        `${sanitize(detail.title)}\n\n${sanitize(detail.text)}`,
      );
      if (reset) this.detailScroll.scrollToStart();
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      this.detail = undefined;
      this.detailBody.setText(
        `Unable to read item\n\n${sanitize(String(error))}`,
      );
    }
    this.tui.requestRender();
  }
  closeDetails() {
    this.detailController?.abort();
    this.reading = false;
    this.detailsVisible?.(false);
    this.tui.requestRender();
  }
  private async run(action: ObjectAction) {
    if (this.acting || this.disposed) return;
    this.acting = true;
    let failure: unknown;
    try {
      await action.run();
    } catch (error) {
      failure = error;
    } finally {
      this.acting = false;
      if (!this.disposed && (!failure || this.refreshRequested)) {
        this.refreshRequested = false;
        await this.refresh();
      }
      if (!this.disposed && failure) {
        this.message = sanitize(String(failure));
        this.failure = true;
        this.tui.requestRender();
      }
    }
  }
  handleInput(data: string) {
    if (this.searching) {
      if (matchesKey(data, "escape")) this.searching = false;
      else {
        this.search.handleInput(data);
        this.filter();
      }
    } else if (data === "/") {
      this.closeDetails();
      this.detail = undefined;
      this.searching = true;
    } else if (matchesKey(data, "ctrl+r")) void this.refresh();
    else if (matchesKey(data, "escape") || matchesKey(data, "left"))
      this.closeDetails();
    else if (matchesKey(data, "up"))
      this.reading ? this.detailScroll.scrollBy(-1) : this.move(-1);
    else if (matchesKey(data, "down"))
      this.reading ? this.detailScroll.scrollBy(1) : this.move(1);
    else if (matchesKey(data, "pageUp"))
      this.reading
        ? this.detailScroll.scrollBy(
            -Math.max(1, this.detailScroll.viewportHeight - 1),
          )
        : this.move(-10);
    else if (matchesKey(data, "pageDown"))
      this.reading
        ? this.detailScroll.scrollBy(
            Math.max(1, this.detailScroll.viewportHeight - 1),
          )
        : this.move(10);
    else if (matchesKey(data, "home")) {
      this.actionIndex = 0;
      this.detailScroll.scrollToStart();
    } else if (matchesKey(data, "tab"))
      this.actionIndex =
        (this.actionIndex + 1) % Math.max(1, this.currentActions().length);
    else if (matchesKey(data, "enter")) {
      const action = this.currentActions()[this.actionIndex];
      if ((this.reading || !this.matches.length) && action)
        void this.run(action);
      else void this.inspect();
    } else if (/^[1-9]$/.test(data)) {
      const action = this.currentActions()[Number(data) - 1];
      if (action) void this.run(action);
    }
    this.tui.requestRender();
  }
  dispose() {
    this.disposed = true;
    this.loadController?.abort();
    this.detailController?.abort();
  }
}
