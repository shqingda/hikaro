import { FileAutocompleteProvider } from "./file-autocomplete.ts";
import {
  TuiAltScreen,
  ProcessTerminal,
  Text,
  Container,
  ScrollView,
  VStack,
  matchesKey,
  isKeyRelease,
  visibleWidth,
  truncateToWidth,
  type Component,
} from "./primitives.ts";
import { createMarkdown } from "./markdown.cjs";
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
  ImageInput,
  FileInput,
  PermissionRequest,
} from "../../core/src/types.ts";
import type { PiUIResponse } from "../../pi-bridge/src/index.ts";

import {
  accent,
  muted,
  bold,
  error as errorText,
  selected,
  setColorScheme,
  markdownTheme as theme,
} from "./theme.ts";
import { renderHeader, renderStatus, type ViewStatus } from "./status.ts";
const MESSAGE_PAGE_CHARS = 16_000;
const STREAM_PREVIEW_CHARS = 64_000;
const MAX_VISIBLE_ITEMS = 40;

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
function toolTarget(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const args = value as Record<string, unknown>;
  const target =
    args.path ?? args.file_path ?? args.query ?? args.pattern ?? args.command;
  return typeof target === "string"
    ? sanitize(target)
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 240)
    : "";
}

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
  private viewStatus: ViewStatus;
  private phase = "Ready";
  readonly footer: Component = {
    render: (width) =>
      renderStatus(
        this.viewStatus,
        this.phase,
        this.preferences.showUsage,
        width,
      ),
    invalidate() {},
  };
  readonly inputError = new Text("", 1, 0);
  private errorMessage = "";
  readonly modelSlot = new Container();
  readonly approvalSlot = new Container();
  private panelYieldsToApproval = false;
  private modelController?: AbortController;
  private preparingPrompt?: AbortController;
  private modelPanel?: ModelPanel;
  readonly historyHint = new Text("", 1, 0);
  readonly header: Component;
  readonly editor: ActivityEditor;
  readonly layout: VStack;
  private draft?: MessageComponent;
  private draftText = "";
  private nextMessage = 1;
  private busy = false;
  private panelCancel?: () => void;
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
  private tools = new Map<string, MessageComponent>();
  private activeTools = new Map<string, string>();
  private toolTargets = new Map<string, string>();
  private removeScheme?: () => void;

  constructor(
    readonly tui: TuiAltScreen,
    readonly options: {
      cwd: string;
      model: string;
      onPrompt: (
        text: string,
        images?: ImageInput[],
        files?: FileInput[],
      ) => Promise<void>;
      preparePrompt?: (
        text: string,
        signal: AbortSignal,
      ) => Promise<{
        text: string;
        images?: ImageInput[];
        files?: FileInput[];
      }>;
      onCommand: (text: string) => Promise<string | void>;
      onExit: () => void;
      /** Shared-host views can detach while an approval or unsent draft is open. */
      detachOnCtrlD?: boolean;
      onHistory?: (direction: HistoryDirection) => Promise<HistoryPage>;
      onReadMessage?: (
        message: Message,
        offset: number,
        limit: number,
      ) => Promise<string>;
      onPreferences?: (patch: Partial<TuiPreferences>) => Promise<void>;
      onDraftChange?: (text: string) => void;
      commands?: Array<{ name: string; description: string }>;
    },
  ) {
    this.viewStatus = {
      connection: "connected",
      model: options.model,
      permission: "",
      cwd: options.cwd,
    };
    this.header = {
      render: (width) => renderHeader(this.viewStatus, width),
      invalidate() {},
    };
    this.editor = new ActivityEditor(
      tui,
      {
        borderColor: muted,
        selectList: {
          selectedPrefix: accent,
          selectedText: selected,
          description: muted,
          scrollInfo: muted,
          noMatch: muted,
        },
      },
      { paddingX: 1 },
    );
    this.editor.onChange = () => {
      if (!this.dialog && !this.disposed)
        options.onDraftChange?.(this.editor.getExpandedText());
    };
    this.editor.setAutocompleteProvider(
      new FileAutocompleteProvider(
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
          { name: "attach", description: "Add a file or image: /attach PATH" },
          {
            name: "paste-image",
            description: "Attach a clipboard image (macOS)",
          },
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
      { component: this.header, basis: "auto", shrink: 0 },
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
      { component: this.editor, basis: "auto", shrink: 0 },
      { component: this.inputError, basis: "auto", maxSize: 2 },
      { component: this.footer, basis: "auto", shrink: 0 },
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
        this.setPreferences({
          ...this.preferences,
          showToolDetails: !this.detail,
        });
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
          void message
            .selectPage(Number(part) - 1)
            .then(() => this.tui.requestRender())
            .catch((error) => this.setError(String(error)));
        }
        return;
      }
      // Before dispatch: an attached host may already stream when run.start arrives.
      warmTextShaping();
      const work = text.startsWith("/")
        ? options.onCommand(text).then((result) => {
            if (result) this.notice(result);
          })
        : options.preparePrompt
          ? this.submitPrompt(text)
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
      if (
        options.detachOnCtrlD &&
        !this.modelPanel &&
        matchesKey(data, "ctrl+d")
      ) {
        options.onExit();
        return { consume: true };
      }
      if (this.approval) {
        this.approval.panel.handleInput(data);
        return { consume: true };
      }
      if (this.preparingPrompt) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
          this.preparingPrompt.abort();
        return { consume: true };
      }
      if (this.modelPanel) {
        if (matchesKey(data, "ctrl+c") && this.panelCancel) {
          this.panelCancel();
          return { consume: true };
        }
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
      if (matchesKey(data, "ctrl+d") && !this.dialog) {
        options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  setError(text: string) {
    const message = sanitize(text.slice(0, 2000));
    if (message && message !== this.errorMessage)
      this.notice(`Error: ${message}`);
    this.errorMessage = message;
    this.inputError.setText(
      text ? errorText(sanitize(text.slice(0, 2000))) : "",
    );
    if (text) this.phase = "Failed";
    this.tui.requestRender();
  }
  closeModelPanel() {
    this.modelController?.abort();
  }
  openModelPanel(options?: {
    onCancel?: () => void;
    yieldToApproval?: boolean;
    interruptYielding?: boolean;
  }) {
    if (options?.interruptYielding && this.panelYieldsToApproval)
      this.modelController?.abort();
    if (this.modelPanel) throw Error("Model picker is already open");
    this.panelYieldsToApproval = options?.yieldToApproval ?? false;
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
              this.editor.render(width).length -
              Math.min(2, this.inputError.render(width).length) -
              this.footer.render(width).length -
              1,
          ),
        ),
    );
    this.panelCancel = options?.onCancel;
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
      this.panelCancel = undefined;
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
    this.phase = "Ready";
    this.activity = "Working";
    this.activeTools.clear();
    this.setError("");
    this.unsubscribe = backend.subscribe((event) => this.event(event));
    this.updateFooter();
  }
  /** Restore authoritative execution state without fabricating run events. */
  restoreExecution(snapshot: {
    busy: boolean;
    stream: string;
    streamTruncated: boolean;
  }) {
    this.busy = snapshot.busy;
    this.phase = snapshot.busy ? "Working" : "Ready";
    this.activity = "Working";
    if (snapshot.stream && !this.history.hasNewer) {
      if (!this.draft) {
        this.draft = new MessageComponent(
          this.nextMessage++,
          "assistant",
          "",
          true,
        );
        this.append(this.draft);
      }
      this.draftText = snapshot.stream.slice(-STREAM_PREVIEW_CHARS);
      this.draft.setText(this.draftText);
    }
    this.updateFooter();
    this.tui.requestRender();
  }
  startTheme() {
    const apply = (light: boolean) => {
      if (this.disposed) return;
      setColorScheme(light);
      this.editor.invalidate();
      this.modelPanel?.invalidate();
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
  setStatus(patch: Partial<ViewStatus>) {
    const next = { ...this.viewStatus, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.viewStatus)) return;
    this.viewStatus = next;
    this.updateFooter();
    this.tui.requestRender();
  }
  setPermissionLabel(permission: string) {
    this.setStatus({ permission });
  }
  setPreferences(preferences: TuiPreferences) {
    this.preferences = { ...preferences };
    this.detail = preferences.showToolDetails;
    for (const item of this.content.children)
      if (item instanceof MessageComponent && item.role === "tool")
        item.setDetails(this.detail);
    this.updateFooter();
    this.tui.requestRender();
  }
  setModel(model: string) {
    this.setStatus({ model });
  }
  private append(component: Component) {
    if (this.disposed) return;
    this.content.addChild(component);
    while (this.content.children.length > MAX_VISIBLE_ITEMS) {
      const removed = this.content.children[0]!;
      this.content.removeChild(removed);
      for (const [id, component] of this.tools)
        if (component === removed) this.tools.delete(id);
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
    this.tools.clear();
    this.toolTargets.clear();
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
  private messageComponent(
    message: Message & { textLength?: number },
    number = this.nextMessage++,
  ) {
    const read = this.options.onReadMessage;
    return new MessageComponent(number, message.role, message.text, false, {
      label:
        message.role === "tool"
          ? `${message.name ?? "tool"}${message.isError ? " failed" : ""}`
          : undefined,
      ...(message.role === "tool"
        ? {
            tool: {
              name: message.name ?? "tool",
              target: message.callId
                ? (this.toolTargets.get(message.callId) ?? "")
                : "",
              state: message.isError ? "Failed" : "Done",
            },
            details: this.detail || message.source === "manual",
            manual: message.source === "manual",
          }
        : {}),
      textLength: message.textLength,
      read:
        read && (message.textLength ?? 0) > message.text.length
          ? (offset, limit) => read(message, offset, limit)
          : undefined,
    });
  }
  private showMessage(message: Message, hideThinking = false) {
    if (message.files) message = { ...message, files: undefined };
    for (const call of message.toolCalls ?? []) {
      this.toolTargets.set(call.id, toolTarget(call.arguments));
      if (this.toolTargets.size > 40)
        this.toolTargets.delete(this.toolTargets.keys().next().value!);
    }
    if (
      message.role === "assistant" &&
      message.thinking &&
      !hideThinking &&
      this.preferences.showThinking
    )
      this.append(
        new Text(
          muted(sanitize(message.thinking.slice(-STREAM_PREVIEW_CHARS))),
          1,
          1,
        ),
      );
    if (message.role === "tool") {
      const existing = message.callId
        ? this.tools.get(message.callId)
        : undefined;
      if (existing) {
        existing.completeTool(
          message.text,
          existing.toolState === "Stopped"
            ? "Stopped"
            : message.isError
              ? "Failed"
              : "Done",
          message.source === "manual",
        );
      } else this.append(this.messageComponent(message));
      return;
    }
    if (
      (message.role === "user" || message.role === "assistant") &&
      message.text
    )
      this.append(this.messageComponent(message));
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
    } else if (event.type === "context.compacting") {
      this.activity = "Compacting";
    } else if (event.type === "context.checkpoint") {
      this.activity = "Working";
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
            this.content.children[index] = this.messageComponent(
              message,
              this.draft.number,
            );
          else this.showMessage(message);
        } else this.showMessage(message, Boolean(this.thinkingDraft));
        this.draft = undefined;
        this.draftText = "";
        this.thinkingDraft = undefined;
        this.thinkingText = "";
      }
    } else if (event.type === "tool.start" || event.type === "tool.end") {
      const id = String(event.data.callId ?? `event-${event.seq}`);
      const name = sanitize(String(event.data.name));
      if (event.type === "tool.start") {
        this.activeTools.set(id, name);
        if (this.activeTools.size > 40)
          this.activeTools.delete(this.activeTools.keys().next().value!);
      } else this.activeTools.delete(id);
      const runningName = this.activeTools.values().next().value;
      this.activity = runningName ? `Running ${runningName}` : "Working";
      if (this.history.hasNewer) {
        this.pendingMessages = true;
        this.updateHistoryHint();
      } else {
        if (event.type === "tool.start") {
          const target = toolTarget(event.data.arguments);
          const component = new MessageComponent(
            this.nextMessage++,
            "tool",
            "",
            false,
            {
              tool: { name, target, state: "Running" },
              details: this.detail,
            },
          );
          this.tools.set(id, component);
          this.append(component);
        } else {
          const result = event.data.result as
            | { text?: string; isError?: boolean; data?: { artifact?: string } }
            | undefined;
          const artifact = result?.data?.artifact;
          let text = result?.text ?? "";
          if (artifact && !text.includes(artifact))
            text += `\n[Complete result: ${artifact}]`;
          const state =
            event.data.status === "cancelled"
              ? "Stopped"
              : result?.isError
                ? "Failed"
                : "Done";
          let component = this.tools.get(id);
          if (!component) {
            component = new MessageComponent(
              this.nextMessage++,
              "tool",
              "",
              false,
              {
                tool: { name, target: this.toolTargets.get(id) ?? "", state },
                details: this.detail,
              },
            );
            this.tools.set(id, component);
            this.append(component);
          }
          component.completeTool(text, state);
        }
      }
    } else if (event.type === "run.end") {
      this.activeTools.clear();
      this.busy = false;
      this.phase =
        event.data.status === "failed"
          ? "Failed"
          : event.data.status === "cancelled"
            ? "Stopped"
            : "Ready";
      for (const tool of this.tools.values())
        if (tool.toolState === "Running")
          tool.completeTool(
            "",
            event.data.status === "cancelled" ? "Stopped" : "Unknown",
          );
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
    this.dialogSavedText = this.editor.getExpandedText();
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
  private async submitPrompt(text: string) {
    if (!this.options.preparePrompt) return this.options.onPrompt(text);
    const controller = new AbortController();
    this.preparingPrompt = controller;
    // Editor.submitValue clears itself first. Restore immediately so both the
    // display and autosave retain the draft until attachment validation succeeds.
    this.editor.setText(text);
    this.editor.disableSubmit = true;
    this.updateFooter();
    let prepared: { text: string; images?: ImageInput[]; files?: FileInput[] };
    try {
      prepared = await this.options.preparePrompt(text, controller.signal);
      controller.signal.throwIfAborted();
    } finally {
      this.preparingPrompt = undefined;
      this.editor.disableSubmit = false;
      this.updateFooter();
    }
    this.editor.setText("");
    return this.options.onPrompt(
      prepared.text,
      prepared.images,
      prepared.files,
    );
  }
  private updateFooter() {
    this.editor.setBodyRows(this.modelPanel || this.approval ? 1 : undefined);
    if (this.approval) this.phase = "Waiting for approval";
    else if (this.preparingPrompt) this.phase = "Loading attachments";
    else if (this.dialog) this.phase = "Waiting for input";
    else if (this.busy) this.phase = this.activity;
    else if (
      this.phase === "Waiting for approval" ||
      this.phase === "Waiting for input" ||
      this.phase === "Loading attachments"
    )
      this.phase = "Ready";
    this.editor.setLabel(
      this.modelPanel || this.approval
        ? "Message · draft preserved"
        : this.busy
          ? "Message · queued on send"
          : "Message",
    );
    this.editor.setHint(
      this.modelPanel || this.approval
        ? "Close the panel to continue editing"
        : this.dialog
          ? this.dialog.method === "confirm"
            ? "Type yes to confirm · Esc cancels"
            : "Enter submits · Esc cancels"
          : this.busy
            ? "Ctrl+C stops · new prompts queue"
            : `Enter send · Shift+Enter newline · /help · @ files${this.status.size ? " · " + [...this.status.values()].join(" · ") : ""}`,
    );
  }

  approve(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    if (this.panelYieldsToApproval) this.modelController?.abort();
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
                this.editor.render(width).length -
                Math.min(2, this.inputError.render(width).length) -
                this.footer.render(width).length -
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
    this.preparingPrompt?.abort();
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
    this.tools.clear();
    this.toolTargets.clear();
    this.draft = undefined;
    this.draftText = "";
  }
}
export function createTerminal() {
  return new TuiAltScreen(new ProcessTerminal(), true);
}
