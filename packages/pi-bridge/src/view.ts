import {
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { ActivityEditor } from "../../tui/src/activity-editor.ts";
import {
  accent,
  muted,
  bold,
  error as errorText,
  setColorScheme,
  editorTheme,
} from "../../tui/src/theme.ts";
import { sanitize } from "../../tui/src/text.ts";
import type { PiTransport } from "./index.ts";

const MAX_TRANSCRIPT_CHARS = 128_000;
const RESUMED_MESSAGES = 20;

type TranscriptEntry = {
  role: "user" | "assistant" | "notice" | "tool";
  text: string;
  id?: string;
  name?: string;
  target?: string;
  status?: "Running" | "Done" | "Failed" | "Stopped" | "Interrupted";
};

export interface PiBridgeSession {
  /** Hikaro session to continue; a new one is created if it cannot be resumed. */
  resumeSessionId?: string;
  onSession?(id: string): void;
}

/** A terminal component hosted by Pi; only Hikaro receives submitted prompts. */
export class PiBridgeView implements Component {
  readonly editor: ActivityEditor;
  private transcript = new Text("", 1, 0);
  private entries: TranscriptEntry[] = [];
  private transcriptDirty = true;
  private outcome = "Ready";
  private assistant?: TranscriptEntry;
  private removeScheme?: () => void;
  private editorY = 0;
  private editorHeight = 0;
  private offset?: number;
  private maxOffset = 0;
  private bodyHeight = 1;
  private connected = false;
  private busy = false;
  private disposed = false;
  private approvals: Array<{ id: string; reason: string }> = [];
  private draft?: string;
  private lost = false;
  private running = false;
  private removeMessage: () => void;
  private removeExit: () => void;

  constructor(
    readonly tui: TUI,
    readonly client: PiTransport,
    private done: () => void,
    private session: PiBridgeSession = {},
  ) {
    this.editor = new ActivityEditor(tui, editorTheme, {
      paddingX: 1,
      autocompleteMaxVisible: 5,
    });
    this.startTheme();
    this.removeMessage = client.subscribe((message) => {
      if (this.disposed) return;
      if (message.type === "event") {
        const event = message.event;
        if (event.type === "text.delta") {
          if (!this.assistant) {
            this.assistant = { role: "assistant", text: "" };
            this.entries.push(this.assistant);
          }
          this.assistant.text += sanitize(String(event.data.text));
          this.changed();
        } else if (event.type === "run.start") {
          this.busy = true;
          this.running = true;
          this.assistant = undefined;
          this.outcome = "Working";
          this.refresh();
        } else if (event.type === "run.end") {
          this.busy = false;
          this.running = false;
          this.approvals = [];
          this.outcome =
            event.data.status === "cancelled"
              ? "Stopped"
              : event.data.status === "failed"
                ? "Failed"
                : "Ready";
          for (const entry of this.entries) {
            if (entry.status === "Running")
              entry.status =
                this.outcome === "Stopped" ? "Stopped" : "Interrupted";
          }
          this.assistant = undefined;
          if (event.data.error) this.append(String(event.data.error));
          this.changed();
        } else if (event.type === "tool.start" || event.type === "tool.end") {
          this.updateTool(event.type, event.data);
        }
      } else if (message.type === "error") {
        // A prompt can be accepted and then refused before its run starts, e.g. a held lease.
        if (!this.running) {
          this.busy = false;
          this.outcome = "Failed";
        }
        this.append(`\n${String(message.error)}\n`);
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
      this.lost = true;
      this.busy = false;
      this.running = false;
      this.approvals = [];
      for (const entry of this.entries)
        if (entry.status === "Running") entry.status = "Interrupted";
      this.append(`\n${error.message}\n/back returns to Pi.\n`);
    });
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    // stdin pipes buffer until Hikaro installs its reader. Waiting for a ready notification
    // risks missing it when a transport is already connected or when a host reconnects.
    void this.connect().then(
      (history) => {
        if (this.disposed || this.lost) return;
        this.connected = true;
        this.entries = [...history, ...this.entries];
        this.changed();
      },
      (error) => {
        this.lost = true;
        this.append(
          `Could not start Hikaro: ${String(error)}\n/back returns to Pi.`,
        );
      },
    );
  }

  private async connect() {
    const id = this.session.resumeSessionId;
    if (id) {
      try {
        await this.client.request("session.resume", { sessionId: id });
        this.session.onSession?.(id);
        // History is context only; a failed read must not discard the resumed session.
        const page = await this.client
          .request("messages.read", { limit: RESUMED_MESSAGES })
          .catch(() => undefined);
        return (page?.items ?? []).flatMap(
          ({ message }: any): TranscriptEntry[] => {
            if (message.role === "user" || message.role === "assistant")
              return [
                {
                  role: message.role,
                  text: sanitize(String(message.text ?? "")),
                },
              ];
            if (message.role === "tool")
              return [
                {
                  role: "tool",
                  name: sanitize(String(message.name ?? "tool")),
                  text: message.isError
                    ? sanitize(String(message.text ?? ""))
                        .split("\n")[0]!
                        .slice(0, 200)
                    : "",
                  status: message.isError ? "Failed" : "Done",
                },
              ];
            return [];
          },
        );
      } catch {
        // Deleted or unreadable sessions fall through to a fresh one.
      }
    }
    const created = await this.client.request("session.create");
    if (typeof created?.id === "string") this.session.onSession?.(created.id);
    return [] as TranscriptEntry[];
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
  private startTheme() {
    const apply = (light: boolean) => {
      if (this.disposed) return;
      setColorScheme(light);
      this.invalidate();
      this.refresh();
    };
    this.removeScheme = this.tui.onTerminalColorSchemeChange?.((scheme) =>
      apply(scheme === "light"),
    );
    const colors = (value: {
      background?: { r: number; g: number; b: number };
    }) => {
      if (value.background)
        apply(
          (value.background.r + value.background.g + value.background.b) / 3 >
            128,
        );
    };
    void this.tui
      .queryTerminalColors?.({ timeoutMs: 100, onLateReply: colors })
      .then(colors)
      .catch(() => {});
  }
  private changed() {
    if (this.disposed) return;
    let length = this.entries.reduce(
      (sum, entry) =>
        sum +
        entry.text.length +
        (entry.target?.length ?? 0) +
        (entry.name?.length ?? 0) +
        32,
      0,
    );
    let trimmed = false;
    while (length > MAX_TRANSCRIPT_CHARS && this.entries.length > 1) {
      const entry = this.entries.shift()!;
      length -=
        entry.text.length +
        (entry.target?.length ?? 0) +
        (entry.name?.length ?? 0) +
        32;
      trimmed = true;
    }
    if (this.entries[0] && length > MAX_TRANSCRIPT_CHARS) {
      this.entries[0].text = this.entries[0].text.slice(
        -MAX_TRANSCRIPT_CHARS + 256,
      );
      trimmed = true;
    }
    if (trimmed) {
      this.entries.unshift({
        role: "notice",
        text: "Earlier output is saved in the Hikaro session.",
      });
      this.offset = undefined;
    }
    this.transcriptDirty = true;
    this.refresh();
  }
  private append(text: string) {
    if (this.disposed) return;
    this.assistant = undefined;
    this.entries.push({ role: "notice", text: sanitize(text).trim() });
    this.changed();
  }
  private updateTool(type: string, data: any) {
    const id = typeof data.callId === "string" ? data.callId : undefined;
    let entry = id
      ? this.entries.find((item) => item.role === "tool" && item.id === id)
      : undefined;
    if (!entry) {
      const args = data.arguments ?? {};
      const target = [
        args.path,
        args.filePath,
        args.file_path,
        args.query,
        args.pattern,
        args.command,
      ].find((value) => typeof value === "string");
      entry = {
        role: "tool",
        id,
        text: "",
        name: sanitize(String(data.name ?? "tool")),
        target: target
          ? sanitize(target).replace(/\s+/g, " ").slice(0, 200)
          : undefined,
      };
      this.entries.push(entry);
    }
    entry.status =
      type === "tool.start"
        ? "Running"
        : data.status === "cancelled"
          ? "Stopped"
          : data.result?.isError
            ? "Failed"
            : "Done";
    entry.text = data.result?.isError
      ? sanitize(String(data.result.text ?? "Tool failed"))
          .split("\n")[0]!
          .slice(0, 200)
      : "";
    this.assistant = undefined;
    this.changed();
  }
  private updateTranscript() {
    if (!this.transcriptDirty) return;
    this.transcriptDirty = false;
    this.transcript.setText(
      this.entries
        .map((entry, index) => {
          const prefix =
            index &&
            (entry.role !== "tool" || this.entries[index - 1]!.role !== "tool")
              ? "\n"
              : "";
          if (entry.role === "tool") {
            const label = `${entry.status ?? "Done"}  ${entry.name ?? "tool"}${entry.target ? "  " + entry.target : ""}${entry.text ? " · " + entry.text : ""}`;
            return (
              prefix +
              "  " +
              (entry.status === "Failed" ? errorText(label) : muted(label)) +
              "\n"
            );
          }
          if (entry.role === "notice") return prefix + muted(entry.text) + "\n";
          return (
            prefix +
            (entry.role === "user" ? bold("YOU") : accent(bold("HIKARO"))) +
            "\n" +
            entry.text +
            "\n"
          );
        })
        .join(""),
    );
  }

  private async submit(input: string) {
    let text = input.trim();
    if (this.disposed || !text) return;
    this.editor.setText("");
    // While disconnected the unsent draft is restored; a command typed after it still applies.
    const draft = this.draft;
    this.draft = undefined;
    if (draft && text.startsWith(draft)) {
      const command = text.slice(draft.length).trim();
      if (command === "/back" || command === "/quit") text = command;
    }
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
      this.editor.setText(draft && text.startsWith(draft) ? draft : input);
      this.draft = this.editor.getText();
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
    this.assistant = undefined;
    this.entries.push({ role: "user", text: sanitize(input) });
    this.busy = true;
    this.outcome = "Working";
    this.changed();
    try {
      await this.client.request("prompt", { text: input });
    } catch (error) {
      this.busy = false;
      this.outcome = "Failed";
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
    const state = !this.connected
      ? this.lost
        ? "Disconnected"
        : "Connecting"
      : this.approvals.length
        ? "Waiting for approval"
        : this.busy
          ? "Working"
          : this.outcome;
    const status = `${state} · Permissions: Hikaro`;
    const footer = new Text(
      state === "Failed" || state === "Disconnected"
        ? errorText(status)
        : muted(status),
      1,
      0,
    ).render(width);
    this.editor.setLabel(
      this.approvals.length ? "Permission response" : "Message",
    );
    this.editor.setHint(
      this.approvals.length
        ? "/allow approves · /deny declines"
        : this.busy
          ? "Ctrl+C stops · /back returns to Pi"
          : "Enter send · PgUp/PgDn scroll",
    );
    this.editor.setBodyRows(Math.max(1, Math.min(6, rows - footer.length - 4)));
    const input = this.editor.render(width);
    this.editorHeight = input.length;
    this.bodyHeight = Math.max(1, rows - input.length - footer.length - 1);
    this.updateTranscript();
    const body = this.transcript.render(width);
    this.maxOffset = Math.max(0, body.length - this.bodyHeight);
    const start = Math.min(this.offset ?? this.maxOffset, this.maxOffset);
    const visible = body.slice(start, start + this.bodyHeight);
    while (visible.length < this.bodyHeight) visible.push("");
    this.editorY = 1 + visible.length;
    return [
      truncateToWidth(
        ` ${accent(bold("hikaro"))} ${muted("· /back returns to Pi")}`,
        width,
      ),
      ...visible,
      ...input,
      ...footer,
    ];
  }

  invalidate() {
    this.transcriptDirty = true;
    this.editor.invalidate();
    this.transcript.invalidate();
  }
  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "ctrl+c")) {
      if (this.busy || this.approvals.length) this.cancel();
      else this.exit();
    } else if (
      matchesKey(data, "ctrl+d") &&
      (!this.editor.getText() || !this.connected)
    )
      this.exit();
    else if (matchesKey(data, "pageUp")) this.move(-this.bodyHeight);
    else if (matchesKey(data, "pageDown")) this.move(this.bodyHeight);
    else if (matchesKey(data, "end") && !this.editor.getText()) {
      this.offset = undefined;
      this.refresh();
    } else this.editor.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.y >= this.editorY && event.y < this.editorY + this.editorHeight)
      return this.editor.handleMouse({
        ...event,
        y: event.y - this.editorY,
        height: this.editorHeight,
      });
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
    this.removeScheme?.();
    this.editor.dispose();
    this.approvals = [];
    void this.client.close().catch(() => {});
  }
}
