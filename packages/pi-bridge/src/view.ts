import {
  Text,
  matchesKey,
  isKeyRelease,
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
import {
  WorkbenchFrame,
  workspaceColumns,
  type WorkspaceTab,
} from "../../tui/src/workbench.ts";
import { ModelPanel } from "../../tui/src/model-panel.ts";
import { MessageComponent } from "../../tui/src/messages.ts";
import {
  openModelPicker,
  type ModelPickerCatalog,
  type ModelPickerOptions,
} from "../../tui/src/model-picker.ts";
import type { ModelChoice } from "../../provider-pi/src/catalog.ts";

const MAX_TRANSCRIPT_CHARS = 128_000;
const RESUMED_MESSAGES = 20;

type TranscriptEntry = {
  role: "user" | "assistant" | "notice" | "tool";
  text: string;
  id?: string;
  name?: string;
  target?: string;
  status?: "Running" | "Done" | "Failed" | "Stopped" | "Interrupted";
  number?: number;
  streaming?: boolean;
};

export interface PiBridgeSession {
  /** Hikaro session to continue; a new one is created if it cannot be resumed. */
  resumeSessionId?: string;
  onSession?(id: string): void;
  cwd?: string;
  /** The extension owns the local credential facade. Secrets never cross RPC. */
  modelCatalog?: ModelPickerCatalog;
  draft?: string;
  onDraft?(text: string): void;
}

/** A terminal component hosted by Pi; only Hikaro receives submitted prompts. */
export class PiBridgeView implements Component {
  readonly editor: ActivityEditor;
  readonly frame: WorkbenchFrame;
  private modelPanel?: ModelPanel;
  private modelController?: AbortController;
  private sessionId?: string;
  private modelLabel?: string;
  private editorX = 0;
  private messages = new WeakMap<TranscriptEntry, MessageComponent>();
  private notices = new WeakMap<TranscriptEntry, Text>();
  private nextMessage = 1;
  private entries: TranscriptEntry[] = [];
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
    if (session.draft) this.editor.setText(session.draft);
    this.frame = new WorkbenchFrame(
      tui,
      {
        render: (width) => this.renderBody(width),
        invalidate: () => this.invalidate(),
      },
      {
        selectTab: (tab) => {
          this.frame.tab = tab;
          this.offset = undefined;
          this.refresh();
        },
        selectSession: () => {},
        sessions: () => {},
        actions: () => {
          void this.openActions();
        },
        inspector: () => false,
        sessionNavigation: false,
        intrinsicHeight: true,
      },
    );
    this.frame.setTabs(["Conversation", "Activity", "Context"]);
    this.startTheme();
    this.removeMessage = client.subscribe((message) => {
      if (this.disposed) return;
      if (message.type === "event") {
        const event = message.event;
        if (event.type === "text.delta") {
          if (!this.assistant) {
            this.assistant = { role: "assistant", text: "", streaming: true };
            this.entries.push(this.assistant);
          }
          this.assistant.text += sanitize(String(event.data.text));
          this.changed();
        } else if (event.type === "run.start") {
          this.busy = true;
          this.running = true;
          this.finishAssistant();
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
          this.finishAssistant();
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
        this.modelController?.abort();
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
      this.modelController?.abort();
      this.lost = true;
      this.busy = false;
      this.running = false;
      this.finishAssistant();
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
        this.frame.setSessions([
          {
            id: this.sessionId ?? "embedded",
            title: "Hikaro session",
            state: this.outcome,
            current: true,
          },
        ]);
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
        this.sessionId = id;
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
    this.sessionId = typeof created?.id === "string" ? created.id : undefined;
    if (typeof created?.id === "string") this.session.onSession?.(created.id);
    return [] as TranscriptEntry[];
  }

  get focused() {
    return this.modelPanel?.focused ?? this.editor.focused;
  }
  set focused(value: boolean) {
    if (this.modelPanel) this.modelPanel.focused = value;
    this.editor.focused = value && !this.modelPanel;
  }
  private refresh() {
    if (!this.disposed) {
      if (this.frame?.sessions[0])
        this.frame.sessions[0].state = !this.connected
          ? "Disconnected"
          : this.busy
            ? "Working"
            : this.outcome;
      this.tui.requestRender();
    }
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
    this.refresh();
  }
  private finishAssistant() {
    if (this.assistant) this.assistant.streaming = false;
    this.assistant = undefined;
  }
  private append(text: string) {
    if (this.disposed) return;
    this.finishAssistant();
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
    this.finishAssistant();
    this.changed();
  }
  private messageFor(entry: TranscriptEntry) {
    if (entry.role === "notice") return undefined;
    let message = this.messages.get(entry);
    if (!message || message.streaming !== !!entry.streaming) {
      entry.number ??= this.nextMessage++;
      message = new MessageComponent(
        entry.number,
        entry.role,
        entry.text,
        !!entry.streaming,
        entry.role === "tool"
          ? {
              tool: {
                name: entry.name ?? "tool",
                target: entry.target ?? "",
                state: entry.status ?? "Done",
              },
            }
          : {},
      );
      this.messages.set(entry, message);
    } else {
      message.setText(entry.text);
      if (entry.role === "tool" && message.toolState !== entry.status)
        message.completeTool(entry.text, entry.status ?? "Done");
    }
    return message;
  }
  private renderTranscript(width: number) {
    return this.entries.flatMap((entry) => {
      if (entry.role !== "notice") return this.messageFor(entry)!.render(width);
      let notice = this.notices.get(entry);
      if (!notice) {
        notice = new Text("", 1, 1);
        this.notices.set(entry, notice);
      }
      notice.setText(muted(entry.text));
      return notice.render(width);
    });
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
      if (draft) this.editor.setText(draft);
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
    if (/^\/(?:model|login|logout)(?:\s|$)/.test(text)) {
      const [command, argument] = text.split(/\s+/, 2);
      await this.models(
        command === "/login"
          ? "login"
          : command === "/logout"
            ? "logout"
            : "models",
        argument,
      );
      return;
    }
    if (/^\/read(?:\s|$)/.test(text)) {
      const [, number, part] = text.split(/\s+/);
      await this.readMessage(
        number ? Number(number) : undefined,
        part ? Number(part) - 1 : 0,
      );
      return;
    }
    if (text.startsWith("/")) {
      this.append(
        "\n/model · /read · /back · /cancel · /steer TEXT · /allow · /deny\n",
      );
      return;
    }
    this.editor.addToHistory(input);
    this.offset = undefined;
    this.finishAssistant();
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
  private openModelPanel() {
    if (this.modelPanel) throw Error("A panel is already open");
    const controller = new AbortController();
    const panel = new ModelPanel(
      controller.signal,
      () => this.refresh(),
      () => Math.max(0, this.tui.terminal.rows - 3),
    );
    this.modelPanel = panel;
    this.modelController = controller;
    panel.focused = true;
    this.editor.focused = false;
    const close = () => {
      if (this.modelPanel !== panel) return;
      this.modelPanel = undefined;
      this.modelController = undefined;
      controller.abort();
      this.editor.focused = true;
      this.refresh();
    };
    controller.signal.addEventListener("abort", close, { once: true });
    this.refresh();
    return { panel, signal: controller.signal, close };
  }
  private async models(
    mode: ModelPickerOptions["mode"] = "models",
    argument?: string,
  ) {
    if (!this.connected || this.disposed) return;
    const local = this.session.modelCatalog;
    if (!local) {
      this.append(
        "Model and account controls are unavailable in this bridge instance.",
      );
      return;
    }
    const adapter: ModelPickerCatalog = {
      providers: () => local.providers(),
      available: async (provider) => {
        const models: ModelChoice[] = [];
        for (let offset = 0; ;) {
          const page = await this.client.request("models.list", {
            ...(provider ? { provider } : {}),
            offset,
            limit: 100,
          });
          if (!Array.isArray(page?.items))
            throw Error("Hikaro returned an invalid model catalogue");
          models.push(...page.items);
          if (!page.hasMore) return models;
          if (!page.items.length) throw Error("Incomplete model catalogue");
          offset += page.items.length;
        }
      },
      login: (provider, method, interaction) =>
        local.login(provider, method, interaction),
      refresh: async (provider, signal) => {
        const warning = await local.refresh(provider, signal);
        signal.throwIfAborted();
        await this.client.request("providers.reload");
        return warning;
      },
      ...(local.logout
        ? {
            logout: (provider: string, signal?: AbortSignal) =>
              local.logout!(provider, signal),
          }
        : {}),
      ...(local.readPreferences
        ? { readPreferences: () => local.readPreferences!() }
        : {}),
      ...(local.setFavorite
        ? {
            setFavorite: (model, enabled) => local.setFavorite!(model, enabled),
          }
        : {}),
      ...(local.recordRecent
        ? { recordRecent: (model) => local.recordRecent!(model) }
        : {}),
    };
    const select = async (
      provider: string,
      model: string,
      makeDefault: boolean,
    ) => {
      if (!this.connected || this.disposed)
        throw Error("Hikaro is disconnected");
      if (this.busy)
        throw Error(
          "Finish or cancel the running Hikaro task before switching models.",
        );
      await this.client.request("model.set", {
        sessionId: this.sessionId,
        provider,
        model,
      });
      if (this.disposed || !this.connected) return;
      this.modelLabel = `${provider}/${model}`;
      if (makeDefault)
        await this.client.request("model.default", {
          sessionId: this.sessionId,
        });
      this.refresh();
    };
    try {
      if (mode === "models" && argument?.includes("/")) {
        const slash = argument.indexOf("/");
        await select(
          argument.slice(0, slash),
          argument.slice(slash + 1),
          false,
        );
        return;
      }
      await openModelPicker(
        {
          openModelPanel: () => this.openModelPanel(),
          setError: (error) => this.append(error),
          notice: (text) => this.append(text),
        },
        adapter,
        select,
        {
          mode,
          provider: mode === "models" ? undefined : argument,
          ownerLabel: "Hikaro local credential store",
          switchBlockedReason: () =>
            this.busy
              ? "Finish or cancel the running Hikaro task before switching models."
              : undefined,
          credentialChangeBlockedReason: () =>
            this.busy
              ? "Finish or cancel the running task before changing shared credentials."
              : undefined,
          onCredentialsChanged: async () => {
            await this.client.request("providers.reload");
          },
          affectedSessions: () =>
            this.sessionId ? [`Current Hikaro session: ${this.sessionId}`] : [],
        },
      );
    } catch (error) {
      if (!this.disposed) this.append(String(error));
    }
  }
  private async readMessage(number?: number, part = 0) {
    if (this.modelPanel || this.disposed) return;
    const messages = this.entries.flatMap((entry) => {
      const message = this.messageFor(entry);
      return message ? [message] : [];
    });
    if (!messages.length) {
      this.append("No retained messages to read.");
      return;
    }
    if (
      (number !== undefined &&
        !messages.some((message) => message.number === number)) ||
      !Number.isInteger(part) ||
      part < 0
    ) {
      this.append(
        "Use /read to choose a retained message, or /read NUMBER PART.",
      );
      return;
    }
    const { panel, signal, close } = this.openModelPanel();
    try {
      const selected =
        number ??
        Number(
          (
            await panel.choose(
              "Messages and execution",
              messages.map((message) => ({
                value: String(message.number),
                label: message.summary,
              })),
              "Choose retained output to read, copy, or reference",
              undefined,
              { search: true },
            )
          ).value,
        );
      const message = messages.find((item) => item.number === selected)!;
      let page = Math.min(part, message.pages - 1);
      for (;;) {
        const text = await message.readPart(page);
        signal.throwIfAborted();
        const action = await panel.readDocument(
          `${message.summary} · ${page + 1}/${message.pages}`,
          text,
          [
            ...(page > 0
              ? [{ value: "previous", label: "Previous part" }]
              : []),
            ...(page + 1 < message.pages
              ? [{ value: "next", label: "Next part" }]
              : []),
            { value: "copy", label: "Copy this part" },
            { value: "reference", label: "Reference this part in draft" },
          ],
        );
        if (action.value === "next") page++;
        else if (action.value === "previous") page--;
        else if (action.value === "copy") {
          const { copyText } = await import("../../tui/src/clipboard-text.ts");
          await copyText(text);
        } else if (action.value === "reference") {
          const draft = this.editor.getExpandedText();
          this.editor.setText(
            `${draft}${draft ? "\n\n" : ""}${message.summary}\n${text}`,
          );
          return;
        } else return;
      }
    } catch (error) {
      if (!signal.aborted) this.append(String(error));
    } finally {
      close();
    }
  }
  private async openActions() {
    if (this.modelPanel || this.disposed) return;
    const { panel, signal, close } = this.openModelPanel();
    try {
      const selected = await panel.choose(
        "Hikaro actions",
        [
          ...(this.session.modelCatalog && this.connected
            ? [{ value: "model", label: "Models and accounts" }]
            : []),
          { value: "Activity", label: "View activity" },
          { value: "Context", label: "View session context" },
          { value: "read", label: "Read, find, or copy retained output" },
          ...(this.busy
            ? [{ value: "cancel", label: "Stop current task" }]
            : []),
          { value: "back", label: "Return to Pi" },
        ],
        "",
        undefined,
        { search: true },
      );
      close();
      if (selected.value === "model") await this.models();
      else if (selected.value === "read") await this.readMessage();
      else if (selected.value === "back") this.exit();
      else if (selected.value === "cancel") this.cancel();
      else {
        this.frame.tab = selected.value as WorkspaceTab;
        this.offset = undefined;
        this.refresh();
      }
    } catch (error) {
      if (!signal.aborted) this.append(String(error));
    } finally {
      close();
    }
  }
  render(width: number): string[] {
    if (width < 8 || this.tui.terminal.rows < 4)
      return [truncateToWidth("Resize terminal", Math.max(1, width))];
    this.editorX = workspaceColumns(width, false).navigation ? 23 : 0;
    const lines = [
      truncateToWidth(
        ` ${accent(bold("hikaro"))} ${muted("· /back returns to Pi")}`,
        width,
      ),
      ...this.frame.render(width),
    ].slice(0, this.tui.terminal.rows);
    // Pi's horizontal compositor adds SGR resets even when no styles were used.
    // Remove only SGR; cursor and IME markers must remain intact.
    return process.env.NO_COLOR !== undefined
      ? lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      : lines;
  }
  private renderBody(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows);
    const state = !this.connected
      ? this.lost
        ? "Disconnected"
        : "Connecting"
      : this.approvals.length
        ? "Waiting for approval"
        : this.busy
          ? "Working"
          : this.outcome;
    const status = `${state} · Permissions: Hikaro${this.modelLabel && width >= 72 ? ` · ${this.modelLabel}` : ""}`;
    const footer = new Text(
      state === "Failed" || state === "Disconnected"
        ? errorText(status)
        : muted(status),
      1,
      0,
    ).render(width);
    if (this.modelPanel) {
      this.editorHeight = 0;
      const panel = this.modelPanel.render(width);
      while (panel.length < rows - footer.length - 2) panel.push("");
      return [
        ...panel.slice(0, Math.max(0, rows - footer.length - 2)),
        ...footer,
      ];
    }
    this.editor.setLabel(
      this.approvals.length ? "Permission response" : "Message",
    );
    this.editor.setHint(
      this.approvals.length
        ? "/allow approves · /deny declines"
        : this.busy
          ? "Ctrl+C stops · /back returns to Pi"
          : "Enter send · Ctrl+P actions · F6 views",
    );
    this.editor.setBodyRows(Math.max(1, Math.min(6, rows - footer.length - 5)));
    const input = this.editor.render(width);
    this.editorHeight = input.length;
    this.bodyHeight = Math.max(1, rows - input.length - footer.length - 2);
    const body =
      this.frame.tab === "Conversation"
        ? this.renderTranscript(width)
        : new Text(
            this.frame.tab === "Activity"
              ? this.entries
                  .filter((entry) => entry.role === "tool")
                  .map(
                    (entry) =>
                      `${entry.status}  ${entry.name}${entry.target ? `  ${entry.target}` : ""}${entry.text ? `\n${entry.text}` : ""}`,
                  )
                  .join("\n") || "No tool activity yet."
              : `Hikaro session: ${this.sessionId ?? "connecting"}\nWorkspace: ${sanitize(this.session.cwd ?? "Current workspace")}\nModel: ${this.modelLabel ?? "Not reported"}\nExecution and permissions: Hikaro\nCredential store: Hikaro local\n/model models and accounts · /back returns to Pi`,
            1,
            0,
          ).render(width);
    this.maxOffset = Math.max(0, body.length - this.bodyHeight);
    const start = Math.min(this.offset ?? this.maxOffset, this.maxOffset);
    const visible = body.slice(start, start + this.bodyHeight);
    while (visible.length < this.bodyHeight) visible.push("");
    this.editorY = 2 + visible.length;
    return [...visible, ...input, ...footer];
  }

  invalidate() {
    this.editor.invalidate();
    for (const entry of this.entries) {
      this.messages.get(entry)?.invalidate();
      this.notices.get(entry)?.invalidate();
    }
  }
  handleInput(data: string) {
    if (this.disposed || isKeyRelease(data)) return;
    if (this.modelPanel) {
      if (matchesKey(data, "escape") && this.modelPanel.cancelStep()) return;
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
        this.modelController?.abort();
      else this.modelPanel.handleInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+p")) {
      void this.openActions();
      return;
    }
    if (matchesKey(data, "f6")) {
      const tabs: WorkspaceTab[] = ["Conversation", "Activity", "Context"];
      this.frame.tab = tabs[(tabs.indexOf(this.frame.tab) + 1) % tabs.length]!;
      this.offset = undefined;
      this.refresh();
      return;
    }
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
    if (event.y === 1)
      return this.frame.tabBar.handleMouse?.({ ...event, y: 0 });
    if (this.modelPanel || event.x < this.editorX) return undefined;
    if (event.y >= this.editorY && event.y < this.editorY + this.editorHeight)
      return this.editor.handleMouse({
        ...event,
        x: event.x - this.editorX,
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
    this.session.onDraft?.(this.editor.getText());
    this.disposed = true;
    this.modelController?.abort();
    this.removeMessage();
    this.removeExit();
    this.removeScheme?.();
    this.editor.dispose();
    this.approvals = [];
    void this.client.close().catch(() => {});
  }
}
