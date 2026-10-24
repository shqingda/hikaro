import {
  Text,
  matchesKey,
  isKeyRelease,
  type Component,
} from "./primitives.ts";
import type { PermissionRequest } from "../../core/src/types.ts";
import { sanitize } from "./text.ts";

const accent = (text: string) => `\x1b[38;2;196;85;72m${text}\x1b[39m`;
const muted = (text: string) => `\x1b[90m${text}\x1b[39m`;

/** A pending operation owns focus; typing never changes the saved composer. */
export class ApprovalPanel implements Component {
  focused = false;
  private allow = true;
  private offset = 0;
  private pageSize = 1;
  private detailRows = 0;
  private readable = false;
  private readyAt = Date.now() + 500;
  private navigated = false;
  private details: string;

  constructor(
    request: PermissionRequest,
    cwd: string,
    private answer: (allowed: boolean) => void,
    private refresh: () => void,
    private maxRows: (width: number) => number,
  ) {
    const file = request.capability;
    const args = request.arguments;
    const target = file
      ? `${file.write ? "Write" : "Read"}: ${JSON.stringify(file.path)}`
      : typeof args.command === "string"
        ? `Command: ${args.command}\nWorkspace: ${cwd}`
        : `Arguments: ${JSON.stringify(args, null, 2)}`;
    this.details = sanitize(
      `Tool: ${request.tool}\n${target}\nReason: ${request.reason}`,
    );
  }

  handleInput(data: string) {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.answer(false);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.allow = matchesKey(data, "up");
      this.navigated = true;
    } else if (matchesKey(data, "pageUp"))
      this.offset = Math.max(0, this.offset - this.pageSize);
    else if (matchesKey(data, "pageDown"))
      this.offset = Math.min(
        Math.max(0, this.detailRows - this.pageSize),
        this.offset + this.pageSize,
      );
    else if (matchesKey(data, "enter")) {
      // Ignore Enter already in flight when the operation took focus.
      if (
        !this.allow ||
        (this.readable && (this.navigated || Date.now() >= this.readyAt))
      )
        this.answer(this.allow);
      return;
    }
    this.refresh();
  }

  render(width: number): string[] {
    const budget = Math.max(1, Math.floor(this.maxRows(width)));
    const text = (value: string) => new Text(value, 1, 0).render(width);
    const title = text(accent("Permission required"));
    const choices = [
      ...text(this.allow ? accent("→ Allow once") : "  Allow once"),
      ...text(!this.allow ? accent("→ Deny") : "  Deny"),
    ];
    const help = text(muted("↑↓ choose · Enter confirm · Esc deny"));
    const rows = text(this.details);
    this.detailRows = rows.length;
    const room = budget - title.length - choices.length - help.length;
    this.readable = room >= 2;
    if (!this.readable)
      return text("Resize to review · Esc denies").slice(0, budget);
    this.pageSize = Math.max(1, room - 1);
    this.offset = Math.min(
      this.offset,
      Math.max(0, rows.length - this.pageSize),
    );
    const visible = rows.slice(this.offset, this.offset + this.pageSize);
    const hint =
      rows.length > this.pageSize
        ? text(
            muted(
              `Details ${this.offset + 1}–${this.offset + visible.length}/${rows.length} · PgUp/PgDn`,
            ),
          )
        : [""];
    return [...title, ...visible, ...hint.slice(0, 1), ...choices, ...help];
  }

  invalidate() {}
}
