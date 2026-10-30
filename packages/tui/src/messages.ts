import {
  Container,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "./primitives.ts";
import { createMarkdown } from "./markdown.cjs";
import {
  accent,
  bold,
  muted,
  error as errorText,
  markdownTheme as theme,
} from "./theme.ts";
import { sanitize } from "./text.ts";
const MESSAGE_PAGE_CHARS = 16_000;

/**
 * End of the last blank-line block boundary that later text cannot change: outside
 * fences, after the whole blank run, before a complete line that does not open a
 * list, table, quote or indented block. Reference definitions can restyle earlier
 * text, so their presence disables the split. Returns 0 when no boundary is safe.
 */
export function stableMarkdownBoundary(text: string) {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return 0;
  let fence: string | undefined,
    boundary = 0;
  const line = /^.*$/gm;
  let blank = false;
  for (let match = line.exec(text); match; match = line.exec(text)) {
    const row = match[0];
    if (match.index === text.length) break;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(row)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !row.trim().slice(marker.length).trim()
      )
        fence = undefined;
    } else if (!row.trim()) blank = true;
    else {
      if (
        blank &&
        match.index > 0 &&
        match.index + row.length < text.length &&
        !/^(\s|[-*+]\s|\d{1,9}[.)]\s|[|>])/.test(row)
      )
        boundary = match.index;
      blank = false;
      if (marker) fence = marker;
    }
    line.lastIndex = match.index + row.length + 1;
  }
  return boundary;
}

/** Streaming preview: only the tail after the stable boundary is parsed again per delta. */
class StreamingMarkdown implements Component {
  private prefixText = "";
  private prefix = createMarkdown("", 1, 0, theme);
  private tail = createMarkdown("", 1, 0, theme);
  private blank = true;
  private last?: { width: number; a: string[]; b: string[]; lines: string[] };
  setText(text: string) {
    this.blank = !text.trim();
    const split = stableMarkdownBoundary(text);
    const prefix = text.slice(0, split);
    if (prefix !== this.prefixText) {
      this.prefixText = prefix;
      this.prefix.setText(prefix);
    }
    this.tail.setText(text.slice(split));
  }
  /** Same lines as one Markdown(text, 1, 1): padding wraps both parts. */
  render(width: number) {
    const a = this.prefix.render(width),
      b = this.tail.render(width);
    if (this.last?.width === width && this.last.a === a && this.last.b === b)
      return this.last.lines;
    // At paddingY 0 a part with no visible block renders a lone "" placeholder.
    const content = [a, b].flatMap((part) =>
      part.length === 1 && part[0] === "" ? [] : part,
    );
    const pad = " ".repeat(width);
    const lines = this.blank ? [] : [pad, ...content, pad];
    this.last = { width, a, b, lines };
    return lines;
  }
  invalidate() {
    this.last = undefined;
    this.prefix.invalidate();
    this.tail.invalidate();
  }
}

let textShapingWarm = false;
/**
 * The first emoji/CJK frame compiles pi-tui's RGI_Emoji regex and loads ICU
 * segmentation (~20–35 ms once per process). Pay it when the user submits, before
 * the run exists, instead of in the first streamed frame. Returns whether it ran.
 */
export function warmTextShaping() {
  if (textShapingWarm) return false;
  textShapingWarm = true;
  createMarkdown(
    sanitize(
      "## 中文 🙂\n\n**粗体** `code` 👍🏽 text, 한국어 かな.\n\n- 项目 🎉",
    ),
    1,
    1,
    theme,
  ).render(80);
  return true;
}

/** Keep Markdown parsing bounded and defer it until the renderer requests a frame. */
export class MessageComponent implements Component {
  onInspect?: () => void;
  private text: string;
  private page = 0;
  private dirty = true;
  private readGeneration = 0;
  private loadedPage?: { page: number; text: string };
  private body = new Container();
  private live?: StreamingMarkdown;
  private rendered?: { width: number; lines: string[] };

  readonly streaming: boolean;
  constructor(
    readonly number: number,
    readonly role: "user" | "assistant" | "tool",
    text: string,
    streaming = false,
    private options: {
      label?: string;
      tool?: { name: string; target: string; state: string };
      details?: boolean;
      manual?: boolean;
      textLength?: number;
      read?: (offset: number, limit: number) => Promise<string>;
    } = {},
  ) {
    this.text = role === "tool" ? sanitize(text) : text;
    this.streaming = streaming;
  }
  setText(text: string) {
    const next = this.role === "tool" ? sanitize(text) : text;
    if (this.text === next) return;
    this.text = next;
    this.dirty = true;
  }
  setDetails(details: boolean) {
    details ||= this.options.manual === true;
    if (this.options.details === details) return;
    this.options.details = details;
    this.dirty = true;
  }
  completeTool(text: string, state: string, manual = false) {
    if (manual) {
      this.options.manual = true;
      this.options.details = true;
    }
    if (this.options.tool) this.options.tool.state = state;
    this.setText(text);
    this.dirty = true;
  }
  get toolState() {
    return this.options.tool?.state;
  }
  get toolName() {
    return this.options.tool?.name;
  }
  get summary() {
    return this.options.tool
      ? `${this.options.tool.state} ${this.options.tool.name} ${this.options.tool.target}`
      : `${this.role === "user" ? "YOU" : "HIKARO"} · ${sanitize(this.text).replace(/\s+/g, " ").slice(0, 100)}`;
  }
  async readPart(page: number) {
    const index = Math.max(0, Math.min(this.pages - 1, page));
    return sanitize(
      this.options.read
        ? await this.options.read(
            index * MESSAGE_PAGE_CHARS,
            MESSAGE_PAGE_CHARS,
          )
        : this.text.slice(
            index * MESSAGE_PAGE_CHARS,
            (index + 1) * MESSAGE_PAGE_CHARS,
          ),
    );
  }
  handleMouse(event: TuiMouseEvent) {
    if (
      event.type === "click" &&
      event.button === "left" &&
      event.y === 0 &&
      this.onInspect
    ) {
      this.onInspect();
      return { handled: true };
    }
  }
  get pages() {
    return Math.max(
      1,
      Math.ceil(
        (this.options.textLength ?? this.text.length) / MESSAGE_PAGE_CHARS,
      ),
    );
  }
  async selectPage(page: number) {
    const next = Math.min(this.pages - 1, Math.max(0, page));
    const generation = ++this.readGeneration;
    if (this.options.read) {
      const text = await this.options.read(
        next * MESSAGE_PAGE_CHARS,
        MESSAGE_PAGE_CHARS,
      );
      if (generation !== this.readGeneration) return;
      this.loadedPage = { page: next, text: sanitize(text) };
    }
    this.page = next;
    this.dirty = true;
  }
  render(width: number) {
    if (!this.dirty && this.rendered?.width === width)
      return this.rendered.lines;
    if (this.rendered && this.rendered.width !== width) this.dirty = true;
    if (this.dirty) {
      this.body.clear();

      // A start that only moves in 2k steps keeps the stable Markdown prefix reusable.
      const text = this.streaming
        ? this.text.slice(
            Math.ceil(
              Math.max(0, this.text.length - MESSAGE_PAGE_CHARS) / 2000,
            ) * 2000,
          )
        : this.loadedPage?.page === this.page
          ? this.loadedPage.text
          : this.text.slice(
              this.page * MESSAGE_PAGE_CHARS,
              (this.page + 1) * MESSAGE_PAGE_CHARS,
            );
      if (this.options.tool) {
        const { name, target, state } = this.options.tool;
        this.body.addChild(
          new Text(
            muted(
              truncateToWidth(
                sanitize(`${state}  ${name}${target ? `  ${target}` : ""}`),
                Math.max(1, width - 2),
              ),
            ),
            1,
            0,
          ),
        );
        if (!this.options.details) {
          if (state === "Failed")
            this.body.addChild(
              new Text(
                errorText(
                  sanitize(this.text.slice(0, 200)).replace(/[\r\n]+/g, " "),
                ),
                3,
                0,
              ),
            );
          this.dirty = false;
          const lines = this.body.render(width);
          this.rendered = { width, lines };
          return lines;
        }
      } else if (this.role !== "tool") {
        this.body.addChild(
          new Text(
            this.role === "user" ? bold("YOU") : accent(bold("HIKARO")),
            1,
            0,
          ),
        );
      }
      if (this.options.label && !this.options.tool)
        this.body.addChild(new Text(muted(sanitize(this.options.label)), 1, 0));
      if (this.role === "tool") this.body.addChild(new Text(muted(text), 1, 1));
      else if (this.streaming) {
        this.live ??= new StreamingMarkdown();
        this.live.setText(sanitize(text));
        this.body.addChild(this.live);
      } else this.body.addChild(createMarkdown(sanitize(text), 1, 1, theme));
      if (this.streaming && this.text.length > MESSAGE_PAGE_CHARS) {
        this.body.addChild(
          new Text(
            muted(
              "Streaming preview · full response is available when the turn finishes",
            ),
            1,
            0,
          ),
        );
      } else if (this.pages > 1) {
        this.body.addChild(
          new Text(
            muted(
              `Message ${this.number} · part ${this.page + 1}/${this.pages} · /read ${this.number} PART`,
            ),
            1,
            1,
          ),
        );
      }
      this.dirty = false;
    }
    const lines = this.body.render(width);
    this.rendered = { width, lines };
    return lines;
  }
  invalidate() {
    this.dirty = true;
    this.body.invalidate();
  }
}

/** Contiguous tool activity is one expandable object; failures remain visible. */
export class ExecutionGroup implements Component {
  readonly messages: MessageComponent[] = [];
  private expanded = false;
  private rows: Array<{
    start: number;
    end: number;
    message: MessageComponent;
  }> = [];
  constructor(
    private refresh: () => void,
    private inspect: (messages: MessageComponent[]) => void,
  ) {}
  add(message: MessageComponent) {
    this.messages.push(message);
  }
  setDetails(expanded: boolean) {
    this.expanded = expanded;
    for (const message of this.messages) message.setDetails(expanded);
  }
  render(width: number) {
    if (this.messages.length === 1) return this.messages[0]!.render(width);
    const counts = new Map<string, number>();
    for (const message of this.messages) {
      const name = message.toolName ?? "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const summary = [...counts]
      .map(([name, count]) => `${count} ${name}`)
      .join(" · ");
    const lines = [
      muted(
        truncateToWidth(
          ` ${this.expanded ? "▾" : "▸"} Execution · ${summary}`,
          width,
        ),
      ),
    ];
    this.rows = [];
    for (const message of this.messages) {
      if (!this.expanded && message.toolState === "Done") continue;
      const start = lines.length;
      lines.push(...message.render(width));
      this.rows.push({ start, end: lines.length, message });
    }
    return lines;
  }
  handleInput(data: string) {
    if (data === " " || matchesKey(data, "right") || matchesKey(data, "left")) {
      this.setDetails(
        data === " " ? !this.expanded : matchesKey(data, "right"),
      );
      this.refresh();
    } else if (matchesKey(data, "enter")) this.inspect(this.messages);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return;
    if (this.messages.length === 1) return this.messages[0]!.handleMouse(event);
    if (event.y === 0) {
      this.setDetails(!this.expanded);
      this.refresh();
      return { handled: true, focus: true };
    }
    const row = this.rows.find(
      (row) => event.y >= row.start && event.y < row.end,
    );
    if (row) {
      row.message.onInspect?.();
      return { handled: true };
    }
  }
  invalidate() {
    for (const message of this.messages) message.invalidate();
  }
}
