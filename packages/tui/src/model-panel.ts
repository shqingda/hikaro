import { stripVTControlCharacters } from "node:util";
import {
  Input,
  SelectList,
  Text,
  CURSOR_MARKER,
  matchesKey,
  isKeyRelease,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
const clean = (v: string) =>
  stripVTControlCharacters(v).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const plain = (v: string) => clean(v);
const accent = (v: string) => `\x1b[38;2;196;85;72m${clean(v)}\x1b[39m`;
const dim = (v: string) => `\x1b[90m${clean(v)}\x1b[39m`;
const red = (v: string) => `\x1b[31m${clean(v)}\x1b[39m`;
export type Selection = {
  value: string;
  makeDefault: boolean;
  action?: "delete" | "rename";
};
/** The input-adjacent panel owns focus only for its lifetime. Secret input never renders raw bytes. */
export class ModelPanel implements Component {
  focused = false;
  private title = "";
  private message = "";
  private error = "";
  private help?: string;
  private allowDelete = false;
  private allowRename = false;
  private cancelValue?: string;
  private input?: Input;
  private list?: SelectList;
  private secret = false;
  private pending?: { resolve: (v: any) => void; reject: (e: Error) => void };
  constructor(
    readonly signal: AbortSignal,
    private refresh: () => void,
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
      allowDelete?: boolean;
      allowRename?: boolean;
      cancelValue?: string;
    },
  ): Promise<Selection> {
    this.title = title;
    this.message = "";
    this.error = warning;
    this.help = help;
    this.allowDelete = options?.allowDelete ?? false;
    this.allowRename = options?.allowRename ?? false;
    this.cancelValue = options?.cancelValue;
    this.secret = false;
    this.input = new Input({
      prompt: "> ",
      placeholder: "Search…",
      placeholderStyle: dim,
    });
    this.list = new SelectList(items, 8, {
      selectedPrefix: accent,
      selectedText: accent,
      description: dim,
      scrollInfo: dim,
      noMatch: dim,
    });
    this.input.focused = true;
    this.list.onSelect = (item) => {
      const p = this.pending;
      this.pending = undefined;
      p?.resolve({ value: item.value, makeDefault: false });
    };
    this.refresh();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  prompt(
    title: string,
    secret = false,
    initial = "",
    options?: { cancelValue?: string },
  ): Promise<string> {
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
    this.pending?.reject(new DOMException("Cancelled", "AbortError"));
    this.pending = undefined;
    this.input?.setValue("");
    this.input = undefined;
    this.list = undefined;
    this.refresh();
  }
  cancelStep() {
    if (!this.pending || this.cancelValue === undefined) return false;
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
      this.list &&
      (matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "enter"))
    ) {
      this.list.handleInput(data);
    } else if (
      this.list &&
      this.allowDelete &&
      (matchesKey(data, "delete") || matchesKey(data, "ctrl+d"))
    ) {
      const item = this.list.getSelectedItem();
      if (item) {
        const p = this.pending;
        this.pending = undefined;
        p?.resolve({ value: item.value, makeDefault: false, action: "delete" });
      }
    } else if (this.list && this.allowRename && matchesKey(data, "ctrl+r")) {
      const item = this.list.getSelectedItem();
      if (item) {
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve({
          value: item.value,
          makeDefault: false,
          action: "rename",
        });
      }
    } else if (this.list && matchesKey(data, "ctrl+s")) {
      const item = this.list.getSelectedItem();
      if (item) {
        const p = this.pending;
        this.pending = undefined;
        p?.resolve({ value: item.value, makeDefault: true });
      }
    } else {
      this.input?.handleInput(data);
      if (this.list) this.list.setFilter(this.input!.getValue());
    }
    this.refresh();
  }
  render(width: number) {
    const lines = new Text(accent(this.title), 1, 1).render(width);
    if (this.input) {
      lines.push(
        ...(this.secret
          ? [
              ` > ${"•".repeat(Math.min(this.input.getValue().length, Math.max(1, width - 5)))}${CURSOR_MARKER}`,
            ]
          : this.input.render(width)),
      );
    }
    if (this.list) {
      if (this.input) lines.push("");
      lines.push(...this.list.render(width));
    }
    if (this.message)
      lines.push(...new Text(dim(this.message), 1, 1).render(width));
    if (this.error)
      lines.push(...new Text(red(this.error), 1, 1).render(width));
    lines.push(
      ...new Text(
        dim(
          this.list
            ? (this.help ??
                "↑↓ select · Enter confirm · Ctrl+S default · Esc cancel")
            : this.pending
              ? "Enter continue · Esc cancel"
              : "Waiting… · Esc cancel",
        ),
        1,
        1,
      ).render(width),
    );
    return lines;
  }
  invalidate() {
    this.input?.invalidate();
    this.list?.invalidate();
  }
}
