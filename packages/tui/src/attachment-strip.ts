import {
  fileReferenceRanges,
  type FileReference,
} from "../../core/src/file-references.ts";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "./primitives.ts";
import { accent, muted, selected } from "./theme.ts";
import { sanitize } from "./text.ts";

/** References are spans in the original draft; removing one never reparses or rewrites the others. */
export class AttachmentStrip implements Component {
  focused = false;
  private index = 0;
  private text = "";
  private references: FileReference[] = [];
  private regions: Array<{ start: number; end: number; index: number }> = [];
  constructor(
    private read: () => string,
    private write: (text: string) => void,
    private inspect: (path: string) => void,
    private refresh: () => void,
  ) {}
  private sync() {
    const text = this.read();
    if (text === this.text) return;
    this.text = text;
    try {
      this.references = fileReferenceRanges(text);
    } catch {
      this.references = [];
    } // An unfinished quote is still editable input.
    this.index = Math.min(this.index, Math.max(0, this.references.length - 1));
  }
  get visible() {
    this.sync();
    return this.references.length > 0;
  }
  remove(path: string) {
    this.sync();
    const reference = this.references.find((item) => item.path === path);
    if (!reference) return;
    this.write(
      this.text.slice(0, reference.start) + this.text.slice(reference.end),
    );
    this.sync();
    this.refresh();
  }
  render(width: number) {
    this.sync();
    this.regions = [];
    let line = muted(" Context "),
      used = 9;
    for (const [index, reference] of this.references.entries()) {
      if (used + 5 > width) break;
      const value =
        truncateToWidth(
          sanitize(reference.path.split("/").at(-1) || reference.path),
          Math.max(1, width - used - 3),
          "…",
        ) + " ×";
      this.regions.push({
        start: used,
        end: used + visibleWidth(value),
        index,
      });
      line +=
        this.focused && index === this.index ? selected(value) : accent(value);
      line += " ";
      used += visibleWidth(value) + 1;
    }
    return [truncateToWidth(line, width)];
  }
  invalidate() {}
  handleInput(data: string) {
    this.sync();
    if (matchesKey(data, "left")) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, "right"))
      this.index = Math.min(this.references.length - 1, this.index + 1);
    const reference = this.references[this.index];
    if (
      reference &&
      (matchesKey(data, "delete") || matchesKey(data, "backspace"))
    )
      this.remove(reference.path);
    else if (reference && matchesKey(data, "enter"))
      this.inspect(reference.path);
    this.refresh();
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "press" || event.button !== "left") return;
    const region = this.regions.find(
      (item) => event.x >= item.start && event.x < item.end,
    );
    if (!region) return;
    this.index = region.index;
    const reference = this.references[this.index]!;
    if (event.x >= region.end - 1) this.remove(reference.path);
    else this.inspect(reference.path);
    return { handled: true };
  }
}
