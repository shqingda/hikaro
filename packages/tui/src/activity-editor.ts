import {
  Editor,
  CURSOR_MARKER,
  FAKE_CURSOR_START,
  FAKE_CURSOR_END,
  truncateToWidth,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
} from "./primitives.ts";
import { accent, muted, editorTheme } from "./theme.ts";
import { sanitize } from "./text.ts";

// Used only inside super.render(); never returned to the terminal.
const bottomBoundary = "\0hikaro-editor-bottom\0";

/** Pi keeps editing and completion; this viewport owns the visible chrome and rows. */
export class ActivityEditor extends Editor {
  private label = "Message";
  private hint = "Enter send · / commands · @ files";
  private above = 0;
  private below = 0;
  private viewportTop = 0;
  private bodyRows?: number;
  private sourceRows: number[] = [];
  private sourceHeight = 0;

  constructor(
    tui: TUI,
    theme: ConstructorParameters<typeof Editor>[1] = editorTheme,
    options: ConstructorParameters<typeof Editor>[2] = {},
  ) {
    super(tui, theme, { ...options, paddingX: 1, autocompleteMaxVisible: 5 });
  }

  setHint(text: string) {
    const next = sanitize(text).replace(/[\r\n]+/g, " ");
    if (this.hint === next) return;
    this.hint = next;
    this.tui.requestRender();
  }

  setLabel(text: string) {
    const next = sanitize(text).replace(/[\r\n]+/g, " ");
    if (this.label === next) return;
    this.label = next;
    this.tui.requestRender();
  }

  /** Optional layout budget; the terminal height may further reduce it. */
  setBodyRows(rows?: number) {
    const next =
      rows === undefined
        ? undefined
        : Math.max(1, Math.min(6, Math.floor(rows)));
    if (this.bodyRows === next) return;
    this.bodyRows = next;
    this.tui.requestRender();
  }

  // Kept for callers migrating activity to the independent status bar.
  setActivity(_label = "", _animate = true) {}

  protected override renderTopBorder(_width: number, hiddenLineCount: number) {
    this.above = hiddenLineCount;
    return "";
  }

  protected override renderBottomBorder(
    _width: number,
    hiddenLineCount: number,
  ) {
    this.below = hiddenLineCount;
    return bottomBoundary;
  }

  override render(width: number) {
    this.setAutocompleteMaxVisible(this.tui.terminal.rows < 18 ? 3 : 5);
    // Ask Pi for its cursor marker even when a panel has focus, solely to keep
    // the viewport anchored. Strip it again before returning an unfocused view.
    const focused = this.focused;
    let source: string[];
    this.focused = true;
    try {
      source = super.render(width);
    } finally {
      this.focused = focused;
    }
    const bottom = source.indexOf(bottomBoundary);
    const body = source.slice(1, bottom);
    const budget = Math.min(
      this.bodyRows ?? 6,
      Math.max(1, Math.min(6, Math.floor(this.tui.terminal.rows / 3) - 2)),
    );
    const cursor = Math.max(
      0,
      body.findIndex((line) => line.includes(CURSOR_MARKER)),
    );
    let start = Math.max(
      0,
      Math.min(body.length - budget, this.viewportTop - this.above),
    );
    if (cursor < start) start = cursor;
    else if (cursor >= start + budget) start = cursor - budget + 1;
    const end = Math.min(body.length, start + budget);
    this.viewportTop = this.above + start;
    this.sourceHeight = source.length;
    this.sourceRows = [0];
    for (let row = start + 1; row <= end; row++) this.sourceRows.push(row);
    // Completion belongs to the editor focus, not a background preserved draft.
    for (let row = bottom; row < (focused ? source.length : bottom + 1); row++)
      this.sourceRows.push(row);
    const result = this.sourceRows.map((row) => source[row]!);
    const overflowAbove = this.above + start;
    const label = truncateToWidth(
      `${this.label}${overflowAbove ? ` · ↑ ${overflowAbove}` : ""}`,
      Math.max(0, width - 4),
      "",
    );
    result[0] = truncateToWidth(
      muted("─ ") +
        accent(label) +
        muted(` ${"─".repeat(Math.max(0, width - visibleWidth(label) - 3))}`),
      width,
      "",
    );
    const overflowBelow = this.below + body.length - end;
    const hint = `${overflowBelow ? `↓ ${overflowBelow} · ` : ""}${this.hint}`;
    result[end - start + 1] = muted(truncateToWidth(` ${hint}`, width, ""));
    // Keep the composer anchored below its suggestions; remap mouse rows with it.
    const completionStart = end - start + 2;
    const completion = result.splice(completionStart);
    const completionRows = this.sourceRows.splice(completionStart);
    result.unshift(...completion);
    this.sourceRows.unshift(...completionRows);
    return focused
      ? result
      : result.map((line) =>
          line
            .replaceAll(CURSOR_MARKER, "")
            .replaceAll(FAKE_CURSOR_START, "")
            .replaceAll(FAKE_CURSOR_END, ""),
        );
  }

  override handleMouse(event: TuiMouseEvent) {
    const sourceY = this.sourceRows[event.y];
    if (sourceY === undefined) return undefined;
    return super.handleMouse({
      ...event,
      y: sourceY,
      height: this.sourceHeight,
    });
  }

  dispose() {}
}
