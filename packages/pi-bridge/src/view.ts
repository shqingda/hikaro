import {
  Editor,
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { sanitize } from "../../tui/src/index.ts";
import type { PiTransport } from "./index.ts";

const plain = (text: string) => text;
const MAX_TRANSCRIPT_CHARS = 128_000;

/** A terminal component hosted by Pi; only Hikaro receives submitted prompts. */
export class PiBridgeView implements Component {
  readonly editor: Editor;
  private transcript = new Text("", 1, 0);
  private text = "Hikaro · connecting…\n";
  private offset?: number;
  private maxOffset = 0;
  private bodyHeight = 1;
  private connected = false;
  private busy = false;
  private disposed = false;
  private approvals: Array<{ id: string; reason: string }> = [];
  private removeMessage: () => void;
  private removeExit: () => void;

  constructor(
    readonly tui: TUI,
    readonly client: PiTransport,
    private done: () => void,
  ) {
    this.editor = new Editor(tui, {
      borderColor: plain,
      selectList: {
        selectedPrefix: plain,
        selectedText: plain,
        description: plain,
        scrollInfo: plain,
        noMatch: plain,
      },
    });
    this.transcript.setText(this.text);
    this.removeMessage = client.subscribe((message) => {
      if (this.disposed) return;
      if (message.type === "event") {
        const event = message.event;
        if (event.type === "text.delta") this.append(String(event.data.text));
        else if (event.type === "run.start") {
          this.busy = true;
          this.refresh();
        } else if (event.type === "run.end") {
          this.busy = false;
          this.approvals = [];
          this.append(
            `\n\n${event.data.status === "cancelled" ? "Stopped\n" : ""}${event.data.error ? String(event.data.error) + "\n" : ""}`,
          );
        } else if (event.type === "tool.end" && event.data.result?.isError) {
          this.append(`\n${event.data.name}: ${event.data.result.text}\n`);
        }
      } else if (message.type === "approval") {
        this.approvals.push({
          id: message.request.id,
          reason: message.request.reason,
        });
        this.append(
          `\nPermission: ${message.request.reason}\n/allow approves this operation · /deny declines\n`,
        );
      }
    });
    this.removeExit = client.onExit((error) => {
      if (this.disposed) return;
      this.connected = false;
      this.busy = false;
      this.approvals = [];
      this.append(`\n${error.message}\n/back returns to Pi.\n`);
    });
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    // stdin pipes buffer until Hikaro installs its reader. Waiting for a ready notification
    // risks missing it when a transport is already connected or when a host reconnects.
    void client.request("session.create").then(
      () => {
        if (this.disposed) return;
        this.connected = true;
        this.text = "Hikaro · /back returns to Pi\n\n";
        this.transcript.setText(this.text);
        this.refresh();
      },
      (error) =>
        this.append(
          `\nCould not start Hikaro: ${String(error)}\n/back returns to Pi.\n`,
        ),
    );
  }

  get focused() {
    return this.editor.focused;
  }
  set focused(value: boolean) {
    this.editor.focused = value;
  }
  private refresh() {
    if (!this.disposed) this.tui.requestRender();
  }
  private append(text: string) {
    if (this.disposed) return;
    this.text += sanitize(text);
    if (this.text.length > MAX_TRANSCRIPT_CHARS) {
      this.text =
        "Earlier output is saved in the Hikaro session.\n" +
        this.text.slice(-MAX_TRANSCRIPT_CHARS);
      this.offset = undefined;
    }
    this.transcript.setText(this.text);
    this.refresh();
  }

  private async submit(input: string) {
    const text = input.trim();
    if (this.disposed || !text) return;
    this.editor.setText("");
    if (text === "/back" || text === "/quit") {
      this.exit();
      return;
    }
    if (text === "/allow" || text === "/deny") {
      const approval = this.approvals.shift();
      if (!approval) {
        this.append("\nNo pending permission request.\n");
        return;
      }
      try {
        await this.client.request("approval.respond", {
          id: approval.id,
          allow: text === "/allow",
        });
      } catch (error) {
        this.append(`\n${String(error)}\n`);
      }
      this.refresh();
      return;
    }
    if (!this.connected) {
      this.editor.setText(input);
      this.append("\nHikaro is not connected. /back returns to Pi.\n");
      return;
    }
    if (text === "/cancel") {
      this.cancel();
      return;
    }
    if (text.startsWith("/steer ")) {
      try {
        await this.client.request("steer", { text: text.slice(7) });
      } catch (error) {
        this.append(`\n${String(error)}\n`);
      }
      return;
    }
    if (text.startsWith("/")) {
      this.append("\n/back · /cancel · /steer TEXT · /allow · /deny\n");
      return;
    }
    this.editor.addToHistory(input);
    this.offset = undefined;
    this.append(`\nYou: ${input}\n\n`);
    this.busy = true;
    try {
      await this.client.request("prompt", { text: input });
    } catch (error) {
      this.busy = false;
      this.append(`\n${String(error)}\n`);
    }
  }
  private cancel() {
    this.approvals = [];
    void this.client
      .request("cancel")
      .catch((error) => this.append(`\n${String(error)}\n`));
  }
  private move(delta: number) {
    const next = Math.max(
      0,
      Math.min(this.maxOffset, (this.offset ?? this.maxOffset) + delta),
    );
    this.offset = next === this.maxOffset ? undefined : next;
    this.refresh();
  }
  render(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows);
    if (width < 8 || rows < 4)
      return [truncateToWidth("Resize terminal", Math.max(1, width))];
    const input = this.editor.render(width);
    const inputHeight = Math.min(
      input.length,
      Math.max(1, Math.floor(rows / 3)),
    );
    this.bodyHeight = Math.max(1, rows - inputHeight - 1);
    const body = this.transcript.render(width);
    this.maxOffset = Math.max(0, body.length - this.bodyHeight);
    const start = Math.min(this.offset ?? this.maxOffset, this.maxOffset);
    const visible = body.slice(start, start + this.bodyHeight);
    while (visible.length < this.bodyHeight) visible.push("");
    const footer = this.approvals.length
      ? "/allow approves · /deny declines · /back returns to Pi"
      : this.busy
        ? "Working · Ctrl+C stops · /back returns to Pi"
        : "Enter send · PageUp/PageDown scroll · Ctrl+D or /back returns to Pi";
    return [
      ...visible,
      ...input.slice(-inputHeight),
      truncateToWidth(footer, width),
    ];
  }
  invalidate() {
    this.editor.invalidate();
    this.transcript.invalidate();
  }
  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "ctrl+c")) {
      if (this.busy || this.approvals.length) this.cancel();
      else this.exit();
    } else if (matchesKey(data, "ctrl+d") && !this.editor.getText())
      this.exit();
    else if (matchesKey(data, "pageUp")) this.move(-this.bodyHeight);
    else if (matchesKey(data, "pageDown")) this.move(this.bodyHeight);
    else if (matchesKey(data, "end") && !this.editor.getText()) {
      this.offset = undefined;
      this.refresh();
    } else this.editor.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") {
      this.move(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    return undefined;
  }
  exit() {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.removeMessage();
    this.removeExit();
    this.approvals = [];
    void this.client.close().catch(() => {});
  }
}
