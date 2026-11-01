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
import type { ImageChip } from "./image-chips.ts";
import { accent, imageChip, muted, working, editorTheme } from "./theme.ts";

/** Rows the composer adds around its body: label line, bottom rule and hint. */
export const editorChromeRows = 3;

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Segment = { segment: string; index: number; input?: string };
type Segmenter = (text: string, mode: "grapheme" | "word") => Iterable<Segment>;

/** Merge each known `[Image #N]` token into one segment, as Pi does for paste markers. */
function mergeTokens(
  segments: Iterable<Segment>,
  text: string,
  tokens: string[],
) {
  const spans: { start: number; end: number }[] = [];
  for (const token of tokens)
    for (
      let at = text.indexOf(token);
      at >= 0;
      at = text.indexOf(token, at + 1)
    )
      spans.push({ start: at, end: at + token.length });
  if (!spans.length) return segments;
  const merged: Segment[] = [];
  for (const segment of segments) {
    const span = spans.find(
      (item) => segment.index >= item.start && segment.index < item.end,
    );
    if (!span) merged.push(segment);
    else if (segment.index === span.start)
      merged.push({
        segment: text.slice(span.start, span.end),
        index: span.start,
        input: text,
      });
  }
  return merged;
}
import { sanitize } from "./text.ts";
import { stripVTControlCharacters } from "node:util";

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
  private activity = "";
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private animated = false;
  private chips: ImageChip[] = [];
  private rendered: string[] = [];
  onOpenImage?: (chip: ImageChip) => void;

  constructor(
    tui: TUI,
    theme: ConstructorParameters<typeof Editor>[1] = editorTheme,
    options: ConstructorParameters<typeof Editor>[2] = {},
  ) {
    super(tui, theme, { ...options, paddingX: 1, autocompleteMaxVisible: 5 });
    // Pi keeps segmentation private; wrap it so image tokens move and delete whole.
    const self = this as unknown as { segment: Segmenter };
    const base = self.segment.bind(this);
    self.segment = (text, mode) =>
      mergeTokens(
        base(text, mode),
        text,
        this.chips.map((chip) => `[${chip.label}]`),
      );
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

  setImageChips(chips: ImageChip[]) {
    const same =
      chips.length === this.chips.length &&
      chips.every(
        (chip, index) =>
          chip.path === this.chips[index]?.path &&
          chip.label === this.chips[index]?.label,
      );
    if (same) return;
    this.chips = chips;
    this.tui.requestRender();
  }

  /** Busy work replaces the composer label with the 0.3.0 spinner. Idle stays still. */
  setActivity(label = "", animate = true) {
    const animated = !!label && animate;
    if (this.activity === label && this.animated === animated) return;
    this.activity = label;
    this.animated = animated;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.frame = 0;
    if (animated) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % frames.length;
        this.tui.requestRender();
      }, 80);
      this.timer.unref?.();
    }
    this.tui.requestRender();
  }

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
    if (this.activity) {
      const text = `${this.animated ? frames[this.frame] + " " : ""}${this.activity}${overflowAbove ? ` · ↑ ${overflowAbove}` : ""}`;
      const label = truncateToWidth(text, Math.max(1, width - 4), "");
      result[0] = truncateToWidth(
        working(
          `── ${label} ${"─".repeat(Math.max(0, width - visibleWidth(label) - 4))}`,
        ),
        width,
        "",
      );
    } else {
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
    }
    const overflowBelow = this.below + body.length - end;
    const hint = `${overflowBelow ? `↓ ${overflowBelow} · ` : ""}${this.hint}`;
    const rule = this.activity ? working : muted;
    result[end - start + 1] = rule("─".repeat(Math.max(0, width)));
    result.splice(
      end - start + 2,
      0,
      muted(truncateToWidth(` ${hint}`, width, "")),
    );
    this.sourceRows.splice(end - start + 2, 0, -2);
    // Keep the composer anchored below its suggestions; remap mouse rows with it.
    const completionStart = end - start + 3;
    const completion = result.splice(completionStart);
    const completionRows = this.sourceRows.splice(completionStart);
    result.unshift(...completion);
    this.sourceRows.unshift(...completionRows);
    for (const chip of this.chips) {
      const token = `[${chip.label}]`;
      for (let row = completion.length; row < result.length; row++)
        if (result[row]!.includes(token))
          result[row] = result[row]!.replaceAll(token, imageChip(token));
    }
    this.rendered = result;
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
    if (event.type === "click") {
      const chip = this.chipAt(event.x, event.y);
      if (chip) {
        this.onOpenImage?.(chip);
        return { handled: true };
      }
    }
    const sourceY = this.sourceRows[event.y];
    if (sourceY === undefined || sourceY < 0) return { handled: true };
    return super.handleMouse({
      ...event,
      y: sourceY,
      height: this.sourceHeight,
    });
  }

  /** The image token under a click on the rendered composer, if any. */
  private chipAt(x: number, y: number) {
    const line = this.rendered[y];
    if (!line || !this.chips.length) return;
    const plain = stripVTControlCharacters(
      line
        .replaceAll(CURSOR_MARKER, "")
        .replaceAll(FAKE_CURSOR_START, "")
        .replaceAll(FAKE_CURSOR_END, ""),
    );
    for (const chip of this.chips) {
      const token = `[${chip.label}]`;
      for (
        let at = plain.indexOf(token);
        at >= 0;
        at = plain.indexOf(token, at + 1)
      ) {
        const start = visibleWidth(plain.slice(0, at));
        if (x >= start && x < start + visibleWidth(token)) return chip;
      }
    }
  }

  dispose() {
    this.setActivity();
  }
}
