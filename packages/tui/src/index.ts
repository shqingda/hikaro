import {
  TuiAltScreen,
  ProcessTerminal,
  Text,
  Container,
  ScrollView,
  VStack,
  Markdown,
  CombinedAutocompleteProvider,
  matchesKey,
  isKeyRelease,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { ModelPanel } from "./model-panel.ts";
import { ActivityEditor } from "./activity-editor.ts";
import { ApprovalPanel } from "./approval-panel.ts";
import { defaultTuiPreferences, type TuiPreferences } from "./preferences.ts";
import { sanitize } from "./text.ts";
export { sanitize } from "./text.ts";
import type {
  AgentBackend,
  AgentEvent,
  Message,
  PermissionRequest,
} from "../../core/src/types.ts";
import type { PiUIResponse } from "../../pi-bridge/src/index.ts";

const accent = (text: string) => `\x1b[38;2;196;85;72m${text}\x1b[39m`;
const muted = (text: string) => `\x1b[90m${text}\x1b[39m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: bold,
  link: accent,
  linkUrl: muted,
  code: accent,
  codeBlock: identity,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: identity,
  underline: identity,
};
const MESSAGE_PAGE_CHARS = 16_000;
const STREAM_PREVIEW_CHARS = 64_000;
const MAX_VISIBLE_ITEMS = 40;

/** Keep Markdown parsing bounded and defer it until the renderer requests a frame. */
export class MessageComponent implements Component {
  private text: string;
  private page = 0;
  private dirty = true;
  private body = new Container();
  static userBackground = "\x1b[48;2;244;225;219m";
  static userForeground = "\x1b[38;2;41;39;37m";
  readonly streaming: boolean;
  constructor(
    readonly number: number,
    readonly role: "user" | "assistant",
    text: string,
    streaming = false,
  ) {
    this.text = text;
    this.streaming = streaming;
  }
  setText(text: string) {
    this.text = text;
    this.dirty = true;
  }
  get pages() {
    return Math.max(1, Math.ceil(this.text.length / MESSAGE_PAGE_CHARS));
  }
  selectPage(page: number) {
    this.page = Math.min(this.pages - 1, Math.max(0, page));
    this.dirty = true;
  }
  render(width: number) {
    if (this.dirty) {
      this.body.clear();

      const text = this.streaming
        ? this.text.slice(-MESSAGE_PAGE_CHARS)
        : this.text.slice(
            this.page * MESSAGE_PAGE_CHARS,
            (this.page + 1) * MESSAGE_PAGE_CHARS,
          );
      this.body.addChild(new Markdown(sanitize(text), 1, 1, theme));
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
    if (this.role === "user") {
      const bg =
        MessageComponent.userBackground + MessageComponent.userForeground;
      return lines.map(
        (line) =>
          bg +
          line
            .replace(/\x1b\[0m/g, "\x1b[0m" + bg)
            .replace(/\x1b\[49m/g, bg)
            .replace(/\x1b\[39m/g, MessageComponent.userForeground) +
          " ".repeat(Math.max(0, width - visibleWidth(line))) +
          "\x1b[49m",
      );
    }
    return lines;
  }
  invalidate() {
    this.body.invalidate();
  }
}

export type HistoryDirection = "older" | "newer" | "latest";
export type HistoryPage = {
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
};
type Dialog = {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  timeout?: number;
};
type UIBackend = AgentBackend & {
  respondToUI?(id: string, response: PiUIResponse): Promise<void>;
};

export class HikaroView {
  readonly content = new Container();
  readonly scroll = new ScrollView(this.content, {
    primary: true,
    follow: "end",
    scrollbar: "auto",
  });
  readonly footer = new Text("", 1, 0);
  readonly permissionStatus = new Text("", 1, 0);
  readonly inputError = new Text("", 1, 0);
  readonly modelSlot = new Container();
  readonly approvalSlot = new Container();
  private modelController?: AbortController;
  private modelPanel?: ModelPanel;
  readonly historyHint = new Text("", 1, 0);
  readonly header: Text;
  readonly editor: ActivityEditor;
  readonly layout: VStack;
  private draft?: MessageComponent;
  private draftText = "";
  private nextMessage = 1;
  private busy = false;
  private activity = "Working";
  private disposed = false;
  private approval?: {
    resolve: (value: boolean) => void;
    cleanup: () => void;
    panel: ApprovalPanel;
  };
  private dialog?: Dialog;
  private dialogs: Dialog[] = [];
  private dialogTimer?: ReturnType<typeof setTimeout>;
  private dialogSavedText = "";
  private unsubscribe?: () => void;
  private removeInput: () => void;
  private detail = false;
  private preferences = { ...defaultTuiPreferences };
  private thinkingDraft?: Text;
  private thinkingText = "";
  private backend?: UIBackend;
  private history = { hasOlder: false, hasNewer: false };
  private historyLoading = false;
  private pendingMessages = false;
  private status = new Map<string, string>();
  private info = "";
  private removeScheme?: () => void;

  constructor(
    readonly tui: TuiAltScreen,
    readonly options: {
      cwd: string;
      model: string;
      onPrompt: (text: string) => Promise<void>;
      onCommand: (text: string) => Promise<string | void>;
      onExit: () => void;
      onHistory?: (direction: HistoryDirection) => Promise<HistoryPage>;
      onPreferences?: (patch: Partial<TuiPreferences>) => Promise<void>;
      commands?: Array<{ name: string; description: string }>;
    },
  ) {
    this.header = new Text(
      `${accent(bold(" H "))} ${bold("hikaro")}  ${muted(sanitize(options.model))}`,
      1,
      1,
    );
    this.editor = new ActivityEditor(
      tui,
      {
        borderColor: (text) => (this.busy ? accent(text) : muted(text)),
        selectList: {
          selectedPrefix: accent,
          selectedText: bold,
          description: muted,
          scrollInfo: muted,
          noMatch: muted,
        },
      },
      { paddingX: 1 },
    );
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          { name: "help", description: "Commands and shortcuts" },
          {
            name: "resources",
            description: "Loaded skills and workspace instructions",
          },
          {
            name: "status",
            description: "Model, context, usage and session status",
          },
          { name: "new", description: "Start a session" },
          { name: "sessions", description: "List sessions" },
          { name: "resume", description: "Resume a session" },
          { name: "rename", description: "Rename this session" },
          {
            name: "export",
            description: "Export the conversation as Markdown",
          },
          { name: "fork", description: "Branch this conversation" },
          {
            name: "model",
            description: "Select a model or connect a provider",
          },
          { name: "login", description: "Connect a provider" },
          {
            name: "settings",
            description: "Display, notifications and startup preferences",
          },
          { name: "permissions", description: "Workspace approval policy" },
          {
            name: "context",
            description: "Select context budget · active / default",
          },
          {
            name: "thinking",
            description: "Select reasoning strength · active / default",
          },
          {
            name: "speed",
            description: "Select supported service tier · active / default",
          },
          { name: "steer", description: "Add instructions during a run" },
          { name: "older", description: "Previous history page" },
          { name: "newer", description: "Next history page" },
          { name: "latest", description: "Return to the latest messages" },
          {
            name: "read",
            description: "Read a part of a long message: /read NUMBER PART",
          },
          { name: "tools", description: "Toggle tool details" },
          { name: "quit", description: "Exit" },
          ...(options.commands ?? []),
        ],
        options.cwd,
      ),
    );
    this.layout = new VStack([
      this.header,
      this.historyHint,
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      {
        component: this.modelSlot,
        basis: "auto",
        maxSize: 18,
        shrink: 0,
        visible: () => !!this.modelPanel,
      },
      {
        component: this.approvalSlot,
        basis: "auto",
        maxSize: 12,
        shrink: 0,
        visible: () => !!this.approval,
      },
      { component: this.editor, basis: "auto", maxSize: 10 },
      this.inputError,
      this.permissionStatus,
      this.footer,
    ]);
    this.updateFooter();
    this.editor.onSubmit = (text) => {
      if (this.disposed) return;
      if (this.approval) return;
      if (this.dialog) {
        void this.answerDialog(text);
        return;
      }
      if (!text.trim()) return;
      this.setError("");
      this.editor.addToHistory(text);
      this.editor.setText("");
      if (text === "/tools") {
        if (options.onPreferences) {
          void options
            .onPreferences({ showToolDetails: !this.detail })
            .catch((e) => this.setError(String(e)));
          return;
        }
        this.detail = !this.detail;
        this.notice(
          this.detail ? "Tool details enabled" : "Tool details hidden",
        );
        return;
      }
      if (["/older", "/newer", "/latest"].includes(text)) {
        void this.loadHistory(text.slice(1) as HistoryDirection);
        return;
      }
      if (text.startsWith("/read ")) {
        const [, number, part] = text.trim().split(/\s+/);
        const message = this.content.children.find(
          (item) =>
            item instanceof MessageComponent && item.number === Number(number),
        );
        if (
          !(message instanceof MessageComponent) ||
          !Number.isInteger(Number(part)) ||
          Number(part) < 1 ||
          Number(part) > message.pages
        )
          this.notice(
            "Use /read MESSAGE PART with the numbers shown below a long message.",
          );
        else {
          message.selectPage(Number(part) - 1);
          this.tui.requestRender();
        }
        return;
      }
      const work = text.startsWith("/")
        ? options.onCommand(text).then((result) => {
            if (result) this.notice(result);
          })
        : options.onPrompt(text);
      void work.catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        this.setError(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    this.removeInput = tui.addInputListener((data) => {
      if (this.disposed) return undefined;
      if (isKeyRelease(data)) return { consume: true };
      if (this.approval) {
        this.approval.panel.handleInput(data);
        return { consume: true };
      }
      if (this.modelPanel) {
        if (matchesKey(data, "escape") && this.modelPanel.cancelStep())
          return { consume: true };
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          this.modelController?.abort();
          return { consume: true };
        }
        return undefined;
      }
      if (matchesKey(data, "ctrl+c")) {
        if (this.dialog) void this.answerDialog(undefined);
        else if (this.busy) this.backend?.cancel();
        else options.onExit();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.dialog) {
        void this.answerDialog(undefined);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) {
        options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  setError(text: string) {
    this.inputError.setText(
      text ? `\x1b[31m${sanitize(text.slice(0, 2000))}\x1b[39m` : "",
    );
    this.tui.requestRender();
  }
  openModelPanel() {
    if (this.modelPanel) throw Error("Model picker is already open");
    this.setError("");
    const controller = new AbortController();
    const panel = new ModelPanel(
      controller.signal,
      () => this.tui.requestRender(),
      (width) =>
        Math.min(
          18,
          Math.max(
            0,
            this.tui.terminal.rows -
              this.header.render(width).length -
              this.historyHint.render(width).length -
              Math.min(10, this.editor.render(width).length) -
              this.inputError.render(width).length -
              this.permissionStatus.render(width).length -
              this.footer.render(width).length -
              1,
          ),
        ),
    );
    this.modelController = controller;
    this.modelPanel = panel;
    this.modelSlot.addChild(panel);
    this.tui.setFocus(panel);
    this.updateFooter();
    this.tui.requestRender();
    const close = () => {
      if (this.modelPanel !== panel) return;
      this.modelSlot.clear();
      this.modelPanel = undefined;
      this.modelController = undefined;
      controller.abort();
      this.tui.setFocus(this.editor);
      this.updateFooter();
      this.tui.requestRender();
    };
    controller.signal.addEventListener("abort", close, { once: true });
    return { panel, signal: controller.signal, close };
  }
  bind(backend: AgentBackend) {
    this.unsubscribe?.();
    this.answer(false);
    this.closeDialog();
    this.dialogs = [];
    this.backend = backend;
    this.busy = false;
    this.unsubscribe = backend.subscribe((event) => this.event(event));
    this.updateFooter();
  }
  startTheme() {
    const apply = (light: boolean) => {
      MessageComponent.userBackground = light
        ? "\x1b[48;2;244;225;219m"
        : "\x1b[48;2;58;39;36m";
      MessageComponent.userForeground = light
        ? "\x1b[38;2;41;39;37m"
        : "\x1b[38;2;244;237;236m";
      this.content.invalidate();
      this.tui.requestRender();
    };
    this.removeScheme = this.tui.onTerminalColorSchemeChange((scheme) =>
      apply(scheme === "light"),
    );
    void this.tui
      .queryTerminalColors({
        timeoutMs: 100,
        onLateReply: (colors) => {
          if (colors.background)
            apply(
              (colors.background.r +
                colors.background.g +
                colors.background.b) /
                3 >
                128,
            );
        },
      })
      .then((colors) => {
        if (colors.background)
          apply(
            (colors.background.r + colors.background.g + colors.background.b) /
              3 >
              128,
          );
      })
      .catch(() => {});
  }
  setInfo(info: string) {
    this.info = sanitize(info);
    this.updateFooter();
    this.tui.requestRender();
  }
  setPermissionLabel(label: string) {
    const text = `Permissions · ${sanitize(label)}`;
    this.permissionStatus.setText(
      label === "Full Access" ? accent(text) : muted(text),
    );
    this.tui.requestRender();
  }
  setPreferences(preferences: TuiPreferences) {
    this.preferences = { ...preferences };
    this.detail = preferences.showToolDetails;
    this.updateFooter();
    this.tui.requestRender();
  }
  setModel(model: string) {
    this.header.setText(
      `${accent(bold(" H "))} ${bold("hikaro")}  ${muted(sanitize(model))}`,
    );
    this.tui.requestRender();
  }
  private append(component: Component) {
    if (this.disposed) return;
    this.content.addChild(component);
    while (this.content.children.length > MAX_VISIBLE_ITEMS) {
      this.content.removeChild(this.content.children[0]!);
      this.history.hasOlder = true;
    }
    this.updateHistoryHint();
    this.tui.requestRender();
  }
  notice(text: string) {
    this.append(new Text(muted(sanitize(text.slice(0, 4000))), 1, 1));
  }

  showMessages(
    messages: Message[],
    flags: Partial<Pick<HistoryPage, "hasOlder" | "hasNewer">> = {},
  ) {
    this.content.clear();
    this.draft = undefined;
    this.draftText = "";
    this.thinkingDraft = undefined;
    this.thinkingText = "";
    this.nextMessage = 1;
    this.history = {
      hasOlder: flags.hasOlder ?? messages.length > 20,
      hasNewer: flags.hasNewer ?? false,
    };
    this.pendingMessages = false;
    for (const message of messages.slice(-20)) this.showMessage(message);
    if (!messages.length)
      this.notice(
        "What would you like to build?\n\nType a task. /help lists commands.",
      );
    this.updateHistoryHint();
    this.scroll.scrollToEnd();
    this.tui.requestRender();
  }

  private async loadHistory(direction: HistoryDirection) {
    if (this.historyLoading) return;
    if (!this.options.onHistory) {
      this.notice("History paging is unavailable for this backend.");
      return;
    }
    if (this.busy) {
      this.notice(
        "Cancel or finish the active run before changing history pages.",
      );
      return;
    }
    this.historyLoading = true;
    this.updateHistoryHint();
    try {
      const page = await this.options.onHistory(direction);
      if (!this.disposed) this.showMessages(page.messages, page);
    } catch (error) {
      this.setError(String(error));
    } finally {
      this.historyLoading = false;
      this.updateHistoryHint();
      this.tui.requestRender();
    }
  }

  private updateHistoryHint() {
    this.historyHint.setText(
      this.historyLoading
        ? muted("Loading history…")
        : this.history.hasOlder || this.history.hasNewer || this.pendingMessages
          ? muted(
              `${this.history.hasOlder ? "/older · " : ""}${this.history.hasNewer ? "/newer · " : ""}/latest${this.pendingMessages ? " · new messages available" : ""}`,
            )
          : "",
    );
  }
  private showMessage(message: Message) {
    if (
      message.role === "assistant" &&
      message.thinking &&
      this.preferences.showThinking
    )
      this.append(
        new Text(
          muted(sanitize(message.thinking.slice(-STREAM_PREVIEW_CHARS))),
          1,
          1,
        ),
      );
    if (message.role === "tool" && this.detail && message.source !== "manual") {
      this.append(
        new Text(
          muted(
            `${sanitize(message.name ?? "tool")}\n${sanitize(message.text.slice(0, 3000))}`,
          ),
          1,
          1,
        ),
      );
      return;
    }
    if (message.role === "tool" && message.source === "manual") {
      this.append(new Text(sanitize(message.text), 1, 1));
      return;
    }
    if (
      (message.role === "user" || message.role === "assistant") &&
      message.text
    )
      this.append(
        new MessageComponent(this.nextMessage++, message.role, message.text),
      );
  }

  event(event: AgentEvent) {
    if (this.disposed) return;
    if (event.type === "run.start") {
      this.setError("");
      this.busy = true;
      this.activity =
        event.data.operation === "compact" ? "Compacting" : "Working";
      this.draft = undefined;
      this.draftText = "";
      this.thinkingDraft = undefined;
      this.thinkingText = "";
    } else if (event.type === "text.delta") {
      this.activity = "Working";
      if (this.history.hasNewer) {
        this.pendingMessages = true;
        this.updateHistoryHint();
        this.updateFooter();
        return;
      }
      if (!this.draft) {
        this.draft = new MessageComponent(
          this.nextMessage++,
          "assistant",
          "",
          true,
        );
        this.append(this.draft);
      }
      this.draftText = (this.draftText + String(event.data.text)).slice(
        -STREAM_PREVIEW_CHARS,
      );
      this.draft.setText(this.draftText);
    } else if (event.type === "thinking.delta") {
      this.activity = "Thinking";
      if (this.preferences.showThinking && !this.history.hasNewer) {
        if (!this.thinkingDraft) {
          this.thinkingDraft = new Text("", 1, 1);
          this.append(this.thinkingDraft);
        }
        this.thinkingText = (this.thinkingText + String(event.data.text)).slice(
          -STREAM_PREVIEW_CHARS,
        );
        this.thinkingDraft.setText(muted(sanitize(this.thinkingText)));
      }
    } else if (event.type === "message") {
      const message = event.data.message as Message;
      if (this.history.hasNewer) {
        this.pendingMessages = true;
        this.updateHistoryHint();
        return;
      }
      if (message.role === "user" || message.source === "manual")
        this.showMessage(message);
      if (message.role === "assistant") {
        if (this.thinkingDraft)
          this.thinkingDraft.setText(
            muted(
              sanitize(
                (message.thinking ?? this.thinkingText).slice(
                  -STREAM_PREVIEW_CHARS,
                ),
              ),
            ),
          );
        else if (
          message.thinking &&
          this.preferences.showThinking &&
          this.draft
        )
          this.append(
            new Text(
              muted(sanitize(message.thinking.slice(-STREAM_PREVIEW_CHARS))),
              1,
              1,
            ),
          );
        if (this.draft) {
          const index = this.content.children.indexOf(this.draft);
          if (index >= 0)
            this.content.children[index] = new MessageComponent(
              this.draft.number,
              "assistant",
              message.text,
            );
          else this.showMessage(message);
        } else
          this.showMessage(
            this.thinkingDraft ? { ...message, thinking: undefined } : message,
          );
        this.draft = undefined;
        this.draftText = "";
        this.thinkingDraft = undefined;
        this.thinkingText = "";
      }
    } else if (event.type === "tool.start") {
      this.activity = `Running ${sanitize(String(event.data.name))}`;
      if (this.detail)
        this.notice(
          `${event.data.name} ${JSON.stringify(event.data.arguments ?? {}).slice(0, 500)}`,
        );
    } else if (event.type === "tool.end") {
      this.activity = "Working";
      const result = event.data.result as
        { text?: string; isError?: boolean } | undefined;
      if (result?.isError && !this.detail)
        this.setError(`${event.data.name}: ${result.text ?? "Tool failed"}`);
      if (this.detail)
        this.notice(
          `${event.data.name}${result?.isError ? " failed" : ""}\n${(result?.text ?? "").slice(0, 3000)}`,
        );
    } else if (event.type === "run.end") {
      this.busy = false;
      if (event.data.status === "failed")
        this.setError(String(event.data.error));
      else if (event.data.status === "cancelled") {
        this.setError("");
        this.notice("Stopped");
      }
      if (event.data.status === "completed" && this.preferences.completionBell)
        this.tui.terminal.write("\x07");
    } else if (event.type === "notice")
      this.notice(String(event.data.text ?? ""));
    else if (event.type === "ui.request") {
      this.dialogs.push(event.data as Dialog);
      this.nextDialog();
    } else if (event.type === "ui.closed") {
      this.dialogs = this.dialogs.filter(
        (dialog) => dialog.id !== event.data.id,
      );
      if (this.dialog?.id === event.data.id) {
        this.closeDialog();
        this.nextDialog();
      }
    } else if (event.type === "ui.editor" && !this.dialog && !this.approval)
      this.editor.setText(String(event.data.text ?? ""));
    else if (event.type === "ui.status") {
      const key = String(event.data.key);
      if (event.data.text)
        this.status.set(key, sanitize(String(event.data.text)).slice(0, 200));
      else this.status.delete(key);
      while (this.status.size > 8)
        this.status.delete(this.status.keys().next().value!);
    }
    this.updateFooter();
    this.tui.requestRender();
  }

  private nextDialog() {
    if (this.dialog || this.approval || !this.dialogs.length) return;
    this.dialog = this.dialogs.shift()!;
    this.dialogSavedText = this.editor.getText();
    this.editor.setText(this.dialog.prefill ?? "");
    this.notice(
      `${this.dialog.title ?? "Pi extension"}${this.dialog.message ? "\n" + this.dialog.message : ""}` +
        (this.dialog.options
          ? "\n" +
            this.dialog.options
              .map((option, index) => `${index + 1}. ${option}`)
              .join("\n")
          : ""),
    );
    if (this.dialog.timeout !== undefined) {
      this.dialogTimer = setTimeout(
        () => {
          void this.answerDialog(undefined);
        },
        Math.max(0, this.dialog.timeout),
      );
      this.dialogTimer.unref();
    }
    this.updateFooter();
  }
  private closeDialog() {
    clearTimeout(this.dialogTimer);
    this.dialogTimer = undefined;
    if (this.dialog) this.editor.setText(this.dialogSavedText);
    this.dialog = undefined;
  }
  private async answerDialog(text: string | undefined) {
    const dialog = this.dialog;
    if (!dialog) return;
    let response: PiUIResponse = { cancelled: true };
    if (text !== undefined) {
      if (dialog.method === "confirm")
        response = { confirmed: /^(yes|y|allow)$/i.test(text.trim()) };
      else if (dialog.method === "select") {
        const value = dialog.options?.[Number(text) - 1] ?? text;
        if (!dialog.options?.includes(value)) {
          this.notice("Enter a listed option or its number. Esc cancels.");
          return;
        }
        response = { value };
      } else response = { value: text };
    }
    this.closeDialog();
    this.updateFooter();
    this.tui.requestRender();
    try {
      await this.backend?.respondToUI?.(dialog.id, response);
    } catch (error) {
      this.setError(String(error));
    }
    this.nextDialog();
    this.updateFooter();
    this.tui.requestRender();
  }
  private updateFooter() {
    this.editor.setActivity(
      this.busy && !this.disposed
        ? this.approval
          ? "Approval required"
          : this.dialog
            ? "Waiting for input"
            : this.activity
        : "",
      !this.approval && !this.dialog && !this.modelPanel,
    );
    if (this.modelPanel || this.approval) {
      this.footer.setText("");
      return;
    }
    this.footer.setText(
      muted(
        (this.info && this.preferences.showUsage ? this.info + "\n" : "") +
          (this.dialog
            ? this.dialog.method === "confirm"
              ? "Type yes to confirm · Esc cancels"
              : "Enter submits · Esc cancels"
            : this.busy
              ? "Ctrl+C stops · new prompts queue"
              : `Enter send · Shift+Enter newline · /help${this.status.size ? " · " + [...this.status.values()].join(" · ") : ""}`),
      ),
    );
  }
  approve(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    if (
      this.approval ||
      this.dialog ||
      this.modelPanel ||
      signal.aborted ||
      this.disposed
    )
      return Promise.resolve(false);
    return new Promise((resolve) => {
      const abort = () => this.answer(false);
      signal.addEventListener("abort", abort, { once: true });
      const panel = new ApprovalPanel(
        request,
        this.options.cwd,
        (value) => this.answer(value),
        () => this.tui.requestRender(),
        (width) =>
          Math.min(
            12,
            Math.max(
              0,
              this.tui.terminal.rows -
                this.header.render(width).length -
                this.historyHint.render(width).length -
                Math.min(10, this.editor.render(width).length) -
                this.inputError.render(width).length -
                this.permissionStatus.render(width).length -
                1,
            ),
          ),
      );
      this.approval = {
        resolve,
        cleanup: () => signal.removeEventListener("abort", abort),
        panel,
      };
      this.approvalSlot.addChild(panel);
      this.tui.setFocus(panel);
      this.updateFooter();
      this.tui.requestRender();
    });
  }
  private answer(value: boolean) {
    const approval = this.approval;
    this.approval = undefined;
    if (approval) {
      this.approvalSlot.clear();
      if (!this.disposed) this.tui.setFocus(this.editor);
      approval.cleanup();
      approval.resolve(value);
    }
    this.nextDialog();
    this.updateFooter();
    if (!this.disposed) this.tui.requestRender();
  }
  dispose() {
    this.modelController?.abort();
    this.removeScheme?.();
    if (this.disposed) return;
    this.disposed = true;
    this.editor.dispose();
    this.removeInput();
    this.unsubscribe?.();
    this.dialogs = [];
    if (this.dialog)
      void this.backend
        ?.respondToUI?.(this.dialog.id, { cancelled: true })
        .catch(() => {});
    this.closeDialog();
    this.answer(false);
    this.content.clear();
    this.draft = undefined;
    this.draftText = "";
  }
}
export function createTerminal() {
  return new TuiAltScreen(new ProcessTerminal(), true);
}
