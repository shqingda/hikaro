import {
  ActionRegistry,
  WorkbenchFrame,
  workspaceTabs,
  type WorkspaceTab,
  type WorkspaceSession,
} from "./workbench.ts";
import { ObjectPage, type ObjectSource } from "./object-page.ts";
import { AttachmentStrip } from "./attachment-strip.ts";
import { parseFileReferences } from "../../core/src/file-references.ts";
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
} from "./theme.ts";
import { renderHeader, renderStatus, type ViewStatus } from "./status.ts";
const STREAM_PREVIEW_CHARS = 64_000;
const MAX_VISIBLE_ITEMS = 40;
import {
  ExecutionGroup,
  MessageComponent,
  warmTextShaping,
} from "./messages.ts";
export {
  MessageComponent,
  warmTextShaping,
  stableMarkdownBoundary,
} from "./messages.ts";
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
  private interventionState?: "pending" | "applied" | "unapplied";
  private interventions = new Map<string, string | undefined>();
  private appliedInterventions = new Set<string>();
  readonly footer: Component = {
    render: (width) =>
      renderStatus(
        this.viewStatus,
        this.phase +
          (this.interventionState
            ? ` · intervention ${this.interventionState}`
            : ""),
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
  readonly attachments: AttachmentStrip;
  readonly layout: VStack;
  readonly frame: WorkbenchFrame;
  readonly actions = new ActionRegistry();
  private pageSlot = new VStack();
  private workspaceSources: Partial<Record<WorkspaceTab, ObjectSource>> = {};
  private pages = new Map<WorkspaceTab, ObjectPage>();
  private visible = true;
  private parkedFocus?: Component;
  private runId?: string;
  private queuePrefix = false;
  private submitMode: "auto" | "queue" = "auto";
  private inspector = false;
  private pendingApprovals: Array<{
    request: PermissionRequest;
    signal: AbortSignal;
    resolve: (value: boolean) => void;
  }> = [];
  get active() {
    return this.visible;
  }
  get isBusy() {
    return this.busy;
  }
  get runIdentity() {
    return this.runId;
  }
  get attentionCount() {
    return this.pendingApprovals.length + (this.approval ? 1 : 0);
  }
  removeDraftAttachment(path: string) {
    this.attachments.remove(path);
  }

  private draft?: MessageComponent;
  private draftText = "";
  private liveText = "";
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
  private welcome?: Text;
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
      onSteer?: (
        text: string,
        expectedRunId?: string,
      ) => Promise<string | void>;
      onCancelRun?: (runId: string) => void | Promise<void>;
      onSelectSession?: (id: string) => Promise<void>;
      onStateChange?: () => void;
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
      /** An explicit backend capability set; omitted by full Hikaro clients. */
      availableActions?: readonly string[];
      active?: boolean;
      previewAttachment?: (
        path: string,
        signal: AbortSignal,
      ) => Promise<string>;
    },
  ) {
    this.visible = options.active ?? true;
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
    this.attachments = new AttachmentStrip(
      () => this.editor.getExpandedText(),
      (text) => {
        this.editor.setText(text);
        options.onDraftChange?.(text);
      },
      (path) => {
        void this.openWorkspaceObject(
          "Context",
          `attachment:${JSON.stringify(path)}`,
        ).catch((error) => this.setError(String(error)));
      },
      () => tui.requestRender(),
    );
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
          ...(options.commands ?? []).filter(
            (command) => !["login", "logout"].includes(command.name),
          ),
        ].filter(
          (command) =>
            !options.availableActions ||
            [
              "model",
              "tools",
              "read",
              "latest",
              "older",
              "quit",
              "steer",
              ...(options.commands ?? []).map((command) => command.name),
            ].includes(command.name),
        ),
        options.cwd,
      ),
    );
    const workspace = new VStack([
      {
        component: this.historyHint,
        shrink: 0,
        visible: () =>
          this.frame.tab === "Conversation" &&
          !this.modelPanel &&
          !this.approval,
      },
      {
        component: this.scroll,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () =>
          this.frame.tab === "Conversation" &&
          !this.modelPanel &&
          !this.approval,
      },
      {
        component: this.pageSlot,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () =>
          this.frame.tab !== "Conversation" &&
          !this.modelPanel &&
          !this.approval,
      },
      {
        component: this.modelSlot,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () => !!this.modelPanel && !this.approval,
      },
      {
        component: this.approvalSlot,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () => !!this.approval,
      },
    ]);
    this.frame = new WorkbenchFrame(tui, workspace, {
      selectTab: (tab) => {
        if (this.approval) return;
        this.modelController?.abort();
        this.selectWorkspace(tab);
      },
      beforeNavigate: () => {
        if (this.approval) return false;
        this.modelController?.abort();
        return true;
      },
      selectSession: (id) => {
        void options
          .onSelectSession?.(id)
          .catch((error) => this.setError(String(error)));
      },
      sessions: () => {
        if (this.approval) return;
        this.modelController?.abort();
        void this.command("/sessions");
      },
      actions: () => {
        void this.openActions();
      },
      inspector: () => this.inspector || !!this.modelPanel || !!this.approval,
      sessionNavigation:
        !options.availableActions ||
        options.availableActions.includes("sessions"),
    });
    this.layout = new VStack([
      { component: this.header, shrink: 0 },
      { component: this.frame, basis: 0, grow: 1, minSize: 1 },
      {
        component: this.attachments,
        shrink: 0,
        visible: () =>
          this.attachments.visible &&
          !this.modelPanel &&
          !this.approval &&
          !(
            tui.terminal.rows < 18 &&
            this.frame.tab !== "Conversation" &&
            tui.getFocusedComponent() !== this.editor
          ),
      },
      {
        component: this.editor,
        shrink: 0,
        visible: () =>
          !(
            tui.terminal.rows < 18 &&
            (this.modelPanel ||
              this.approval ||
              (this.frame.tab !== "Conversation" &&
                tui.getFocusedComponent() !== this.editor))
          ),
      },
      { component: this.inputError, shrink: 0, maxSize: 2 },
      { component: this.footer, shrink: 0 },
    ]);
    this.setWorkspaceSources({
      Context: {
        title: "Context",
        description: "Draft references and model context settings",
        load: async () => [
          { id: "draft", title: "Draft and file references" },
          { id: "resources", title: "Workspace instructions and skills" },
          { id: "model", title: "Model context and reasoning" },
        ],
        detail: async (item) => ({
          title: item.title,
          text:
            item.id === "draft"
              ? this.editor.getExpandedText() ||
                "No draft attachments. Add files using @ or /attach."
              : item.id === "model"
                ? this.viewStatus.model
                : "Inspect the resources loaded by this backend.",
          actions:
            item.id === "draft"
              ? [
                  {
                    id: "edit",
                    title: "Return to input",
                    run: () => {
                      this.tui.setFocus(this.editor);
                    },
                  },
                ]
              : [
                  {
                    id: "open",
                    title: "Open " + item.title,
                    run: () =>
                      this.command(
                        item.id === "model" ? "/model" : "/resources",
                      ),
                  },
                ],
        }),
      },
    });
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
        const message = this.loadedMessages().find(
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
      const mode = this.submitMode;
      this.submitMode = "auto";
      const tabCommand = (
        {
          "/changes": "Changes",
          "/tasks": "Activity",
          "/context": "Context",
        } as const
      )[text as "/changes" | "/tasks" | "/context"];
      if (tabCommand && this.workspaceSources[tabCommand]) {
        this.selectWorkspace(tabCommand);
        return;
      }
      const work = text.startsWith("/")
        ? options.onCommand(text).then((result) => {
            if (result) this.notice(result);
          })
        : this.submitPrompt(text, mode);
      void work.catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        this.setError(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    this.removeInput = tui.addInputListener((data) => {
      if (this.disposed || !this.visible) return undefined;
      if (isKeyRelease(data)) return { consume: true };
      if (
        options.detachOnCtrlD &&
        !this.modelPanel &&
        matchesKey(data, "ctrl+d")
      ) {
        options.onExit();
        return { consume: true };
      }
      if (
        !this.approval &&
        !this.dialog &&
        !this.modelPanel &&
        !this.preparingPrompt
      ) {
        if (matchesKey(data, "ctrl+p")) {
          void this.openActions();
          return { consume: true };
        }
        if (
          matchesKey(data, "ctrl+o") &&
          (!options.availableActions ||
            options.availableActions.includes("sessions"))
        ) {
          void this.command("/sessions");
          return { consume: true };
        }
        if (matchesKey(data, "f6") || matchesKey(data, "shift+f6")) {
          const targets: Component[] = [
            this.editor,
            this.frame.tabBar,
            ...(this.frame.sessions.length ? [this.frame.navigation] : []),
            ...(this.pages.get(this.frame.tab)
              ? [this.pages.get(this.frame.tab)!]
              : [this.scroll]),
            ...(this.attachments.visible ? [this.attachments] : []),
          ];
          const i = targets.indexOf(this.tui.getFocusedComponent()!);
          this.tui.setFocus(
            targets[
              (i + (matchesKey(data, "shift+f6") ? targets.length - 1 : 1)) %
                targets.length
            ]!,
          );
          if (
            this.tui.getFocusedComponent() === this.frame.navigation &&
            this.tui.terminal.columns < 100
          )
            this.frame.navigationOpen = true;
          else this.frame.navigationOpen = false;
          this.tui.requestRender();
          return { consume: true };
        }
        if (this.tui.getFocusedComponent() === this.editor) {
          if (matchesKey(data, "ctrl+x")) {
            this.queuePrefix = true;
            this.editor.setHint(
              "Enter queue · another key cancels queue shortcut",
            );
            return { consume: true };
          }
          if (this.queuePrefix) {
            this.queuePrefix = false;
            this.updateFooter();
            if (matchesKey(data, "enter")) {
              this.submitMode = "queue";
              queueMicrotask(() => {
                this.submitMode = "auto";
              });
            }
          }
        }
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
        else if (this.busy)
          void this.actions
            .run("stop")
            .catch((error) => this.setError(String(error)));
        else options.onExit();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.dialog) {
        void this.answerDialog(undefined);
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.frame.tab !== "Conversation") {
        const page = this.pages.get(this.frame.tab);
        if (page && !page.inspecting && !page.searchActive) {
          this.selectWorkspace("Conversation");
          return { consume: true };
        }
      }
      if (matchesKey(data, "ctrl+d") && !this.dialog) {
        options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  setActive(active: boolean) {
    if (!active && this.visible)
      this.parkedFocus = this.tui.getFocusedComponent() ?? undefined;
    this.visible = active;
    if (active) {
      this.nextDialog();
      this.presentApproval();
      this.tui.setFocus(
        this.approval?.panel ??
          this.modelPanel ??
          this.parkedFocus ??
          this.editor,
      );
      this.tui.requestRender();
    }
  }
  setSessions(sessions: WorkspaceSession[]) {
    this.frame.setSessions(sessions);
    this.setStatus({
      sessionTitle: sessions.find((session) => session.current)?.title,
    });
  }
  setWorkspaceSources(sources: Partial<Record<WorkspaceTab, ObjectSource>>) {
    let reopen = false;
    for (const tab of workspaceTabs) {
      if (
        sources[tab] &&
        sources[tab] !== this.workspaceSources[tab] &&
        this.pages.has(tab)
      ) {
        const old = this.pages.get(tab)!;
        if (this.parkedFocus === old) this.parkedFocus = this.editor;
        old.dispose();
        this.pages.delete(tab);
        if (this.frame.tab === tab) reopen = true;
      }
    }
    Object.assign(this.workspaceSources, sources);
    this.frame.setTabs([
      "Conversation",
      ...workspaceTabs.filter((tab) => !!this.workspaceSources[tab]),
    ]);
    this.actions.set(
      [
        ...workspaceTabs
          .filter((tab) => tab === "Conversation" || this.workspaceSources[tab])
          .map((tab) => ({
            id: `view.${tab}`,
            title: `Show ${tab.toLowerCase()}`,
            run: () => this.selectWorkspace(tab),
          })),
        {
          id: "sessions",
          title: "Switch session",
          shortcut: "Ctrl+O",
          run: () => this.command("/sessions"),
        },
        { id: "new", title: "New session", run: () => this.command("/new") },
        {
          id: "close",
          title: "Close this session view",
          description: "Running work remains monitored",
          run: () => this.command("/close"),
        },
        {
          id: "model",
          title: "Models and provider accounts",
          run: () => this.command("/model"),
        },
        {
          id: "settings",
          title: "Settings",
          run: () => this.command("/settings"),
        },
        {
          id: "permissions",
          title: "Review permissions",
          run: () => this.command("/permissions"),
        },
        {
          id: "search",
          title: "Search this conversation",
          run: () => this.command("/search"),
        },
        {
          id: "inspect",
          title: "Inspect messages and execution results",
          run: () => this.inspectMessages(this.loadedMessages()),
        },
        {
          id: "queue",
          title: "Queue draft for later",
          shortcut: "Ctrl+X Enter",
          enabled: () =>
            !!this.editor.getExpandedText().trim() || "The draft is empty",
          run: () => {
            this.submitMode = "queue";
            this.editor.onSubmit?.(this.editor.getExpandedText());
          },
        },
        {
          id: "stop",
          title: "Stop current run",
          shortcut: "Ctrl+C",
          enabled: () =>
            !this.busy
              ? "No run is active"
              : this.viewStatus.connection !== "connected"
                ? "Disconnected or synchronizing"
                : this.options.onCancelRun && !this.runId
                  ? "Run identity is unknown; wait for synchronization"
                  : true,
          run: async () => {
            if (this.runId && this.options.onCancelRun)
              await this.options.onCancelRun(this.runId);
            else this.backend?.cancel();
          },
        },
        {
          id: "latest",
          title: "Return to latest messages",
          run: () => {
            this.selectWorkspace("Conversation");
            this.scroll.scrollToEnd();
            this.pendingMessages = false;
            this.updateHistoryHint();
            if (this.history.hasNewer) void this.loadHistory("latest");
          },
        },
        {
          id: "older",
          title: "Read earlier messages",
          run: () => this.loadHistory("older"),
        },
        {
          id: "export",
          title: "Export conversation",
          run: () => this.command("/export"),
        },
      ].filter(
        (action) =>
          action.id.startsWith("view.") ||
          !this.options.availableActions ||
          this.options.availableActions.includes(action.id),
      ),
    );
    if (reopen) this.selectWorkspace(this.frame.tab);
  }
  selectWorkspace(tab: WorkspaceTab) {
    if (tab !== "Conversation" && !this.workspaceSources[tab]) return;
    this.frame.tab = tab;
    this.frame.navigationOpen = false;
    this.pageSlot.clear();
    if (tab !== "Conversation") {
      let page = this.pages.get(tab);
      if (!page) {
        page = new ObjectPage(
          this.workspaceSources[tab]!,
          this.tui,
          (visible) => {
            if (this.frame.tab === tab) {
              this.inspector = visible;
              this.tui.requestRender();
            }
          },
        );
        this.pages.set(tab, page);
      }
      void page.refresh();
      this.pageSlot.addChild(page, { basis: 0, grow: 1, minSize: 1 });
      this.inspector = page.inspecting;
      if (this.visible) this.tui.setFocus(page);
    } else {
      this.inspector = false;
      if (this.visible) this.tui.setFocus(this.editor);
    }
    this.tui.requestRender();
  }
  refreshWorkspace(tab?: WorkspaceTab) {
    const page = this.pages.get(tab ?? this.frame.tab);
    if (page) void page.refresh();
  }
  async openWorkspaceObject(tab: WorkspaceTab, id: string) {
    this.selectWorkspace(tab);
    const page = this.pages.get(tab);
    if (!page) throw Error("This backend does not provide that workspace view");
    await page.open(id);
  }
  async command(text: string) {
    try {
      const result = await this.options.onCommand(text);
      if (result) this.notice(result);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        this.setError(String(error));
    }
  }
  async openActions() {
    if (this.approval) return;
    if (this.modelPanel) {
      this.modelController?.abort();
      return;
    }
    const { panel, close } = this.openModelPanel();
    try {
      const choice = await panel.choose(
        "Commands",
        this.actions.search().map((action) => ({
          value: action.id,
          label: action.title,
          description: [
            action.shortcut,
            typeof action.enabled?.() === "string"
              ? action.enabled?.()
              : action.description,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        "",
        undefined,
        {
          search: true,
          description: "Find models, sessions, changes and settings",
        },
      );
      close();
      await this.actions.run(choice.value);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        this.setError(String(error));
    } finally {
      close();
    }
  }
  private loadedMessages() {
    return this.content.children.flatMap((item) =>
      item instanceof ExecutionGroup
        ? item.messages
        : item instanceof MessageComponent
          ? [item]
          : [],
    );
  }
  async inspectMessages(messages: MessageComponent[]) {
    if (!messages.length || this.modelPanel || this.approval) return;
    const { panel, signal, close } = this.openModelPanel();
    try {
      const choice =
        messages.length === 1
          ? String(messages[0]!.number)
          : (
              await panel.choose(
                "Messages and execution",
                messages.map((message) => ({
                  value: String(message.number),
                  label: message.summary,
                })),
                "Choose a result to read, copy, or reference",
                undefined,
                { search: true },
              )
            ).value;
      const message = messages.find(
        (message) => String(message.number) === choice,
      )!;
      let page = 0;
      for (;;) {
        const text = await message.readPart(page);
        signal.throwIfAborted();
        const choice = await panel.readDocument(
          `${message.summary} · ${page + 1}/${message.pages}`,
          text,
          [
            ...(page ? [{ value: "previous", label: "Previous part" }] : []),
            ...(page + 1 < message.pages
              ? [{ value: "next", label: "Next part" }]
              : []),
            { value: "reference", label: "Reference this part in draft" },
            { value: "copy", label: "Copy this part" },
          ],
        );
        if (choice.value === "next") page++;
        else if (choice.value === "previous") page--;
        else if (choice.value === "reference") {
          this.editor.setText(
            `${this.editor.getExpandedText()}${this.editor.getExpandedText() ? "\n\n" : ""}${message.summary}\n${text}`,
          );
          this.options.onDraftChange?.(this.editor.getExpandedText());
          close();
          return;
        } else if (choice.value === "copy") {
          const { copyText } = await import("./clipboard-text.ts");
          await copyText(text);
          this.notice("Copied this part to clipboard");
        } else return;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        this.setError(String(error));
    } finally {
      close();
    }
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
    const previousFocus = this.tui.getFocusedComponent();
    const controller = new AbortController();
    const panel = new ModelPanel(
      controller.signal,
      () => this.tui.requestRender(),
      () =>
        Math.max(
          0,
          this.tui.terminal.rows -
            (this.tui.terminal.rows < 18
              ? 0
              : this.editor.render(this.tui.terminal.columns).length) -
            5,
        ),
    );
    this.panelCancel = options?.onCancel;
    this.modelController = controller;
    this.modelPanel = panel;
    this.modelSlot.addChild(panel);
    if (this.visible) this.tui.setFocus(panel);
    this.updateFooter();
    this.tui.requestRender();
    const close = () => {
      if (this.modelPanel !== panel) return;
      this.modelSlot.clear();
      this.modelPanel = undefined;
      this.modelController = undefined;
      this.panelCancel = undefined;
      if (this.parkedFocus === panel)
        this.parkedFocus = previousFocus ?? this.editor;
      controller.abort();
      if (this.visible)
        this.tui.setFocus(this.approval?.panel ?? previousFocus ?? this.editor);
      this.presentApproval();
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
    runId?: string | null;
  }) {
    this.busy = snapshot.busy;
    this.runId = snapshot.runId ?? this.runId;
    this.phase = snapshot.busy ? "Working" : "Ready";
    this.activity = "Working";
    this.liveText = snapshot.stream.slice(-STREAM_PREVIEW_CHARS);
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
    for (const item of this.content.children) {
      if (item instanceof ExecutionGroup) item.setDetails(this.detail);
      else if (item instanceof MessageComponent && item.role === "tool")
        item.setDetails(this.detail);
    }
    this.updateFooter();
    this.tui.requestRender();
  }
  setModel(model: string) {
    this.setStatus({ model });
  }
  private append(component: Component) {
    if (this.disposed) return;
    if (component instanceof MessageComponent && this.welcome) {
      this.content.removeChild(this.welcome);
      this.welcome = undefined;
    }
    if (component instanceof MessageComponent)
      component.onInspect = () => {
        void this.inspectMessages([component]);
      };
    if (component instanceof MessageComponent && component.role === "tool") {
      let group = this.content.children.at(-1);
      if (!(group instanceof ExecutionGroup)) {
        group = new ExecutionGroup(
          () => this.tui.requestRender(),
          (messages) => {
            void this.inspectMessages(messages);
          },
        );
        this.content.addChild(group);
      }
      (group as ExecutionGroup).add(component);
      if (this.detail) (group as ExecutionGroup).setDetails(true);
    } else this.content.addChild(component);
    while (
      this.content.children.reduce(
        (n, item) =>
          n + (item instanceof ExecutionGroup ? item.messages.length : 1),
        0,
      ) > MAX_VISIBLE_ITEMS
    ) {
      const removed = this.content.children[0]!;
      const message =
        removed instanceof ExecutionGroup ? removed.messages.shift() : removed;
      if (!(removed instanceof ExecutionGroup) || !removed.messages.length)
        this.content.removeChild(removed);
      for (const [id, component] of this.tools)
        if (component === message) this.tools.delete(id);
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
    this.welcome = undefined;
    for (const message of messages.slice(-20)) this.showMessage(message);
    if (!messages.length) {
      this.welcome = new Text(muted("What would you like to work on?"), 1, 1);
      this.content.addChild(this.welcome);
    }
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
    this.historyLoading = true;
    this.updateHistoryHint();
    try {
      const page = await this.options.onHistory(direction);
      if (!this.disposed) {
        this.showMessages(page.messages, page);
        if (!page.hasNewer && this.busy && this.liveText) {
          this.draft = new MessageComponent(
            this.nextMessage++,
            "assistant",
            "",
            true,
          );
          this.draftText = this.liveText;
          this.draft.setText(this.liveText);
          this.append(this.draft);
        }
      }
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
              `${this.pendingMessages ? "New messages available · " : ""}Ctrl+P → ${this.history.hasOlder ? "Read earlier / " : ""}Return to latest messages`,
            )
          : "",
    );
  }
  private messageComponent(
    message: Message & { textLength?: number },
    number = this.nextMessage++,
  ) {
    const read = this.options.onReadMessage;
    const component = new MessageComponent(
      number,
      message.role,
      message.text,
      false,
      {
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
      },
    );
    component.onInspect = () => {
      void this.inspectMessages([component]);
    };
    return component;
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
    if (
      !this.scroll.isFollowingEnd &&
      ["text.delta", "message", "tool.start", "tool.end"].includes(event.type)
    ) {
      this.pendingMessages = true;
      this.updateHistoryHint();
    }
    if (event.type === "run.start") {
      if (!this.interventions.size) this.interventionState = undefined;
      this.setError("");
      this.busy = true;
      this.runId =
        typeof event.data.runId === "string" ? event.data.runId : undefined;
      this.activity =
        event.data.operation === "compact" ? "Compacting" : "Working";
      this.draft = undefined;
      this.draftText = "";
      this.liveText = "";
      this.thinkingDraft = undefined;
      this.thinkingText = "";
    } else if (event.type === "context.compacting") {
      this.activity = "Compacting";
    } else if (event.type === "context.checkpoint") {
      this.activity = "Working";
    } else if (event.type === "text.delta") {
      this.activity = "Working";
      this.liveText = (this.liveText + String(event.data.text)).slice(
        -STREAM_PREVIEW_CHARS,
      );
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
      this.draftText = this.liveText;
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
      if (typeof event.data.steeringId === "string") {
        const id = event.data.steeringId;
        this.appliedInterventions.add(id);
        if (this.appliedInterventions.size > 64)
          this.appliedInterventions.delete(
            this.appliedInterventions.values().next().value!,
          );
        this.interventions.delete(id);
        this.interventionState = this.interventions.size
          ? "pending"
          : "applied";
        this.notice("Intervention applied at the model turn");
      }
      const message = event.data.message as Message;
      if (message.role === "assistant") this.liveText = "";
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
      for (const [id, run] of this.interventions) {
        if (run === this.runId) {
          this.interventions.delete(id);
          this.interventionState = "unapplied";
        }
      }
      if (this.interventionState === "unapplied")
        this.notice(
          "Intervention not applied · review it in Activity before sending again",
        );
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
    if (!["text.delta", "thinking.delta"].includes(event.type))
      this.options.onStateChange?.();
    if (
      ["tool.end", "run.end", "steering.applied"].includes(event.type) &&
      this.visible &&
      this.frame.tab !== "Conversation"
    )
      this.refreshWorkspace();
    this.tui.requestRender();
  }

  private nextDialog() {
    if (!this.visible || this.dialog || this.approval || !this.dialogs.length)
      return;
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
  private async submitPrompt(text: string, mode: "auto" | "queue" = "auto") {
    const intervene =
      mode !== "queue" &&
      this.busy &&
      !!this.options.onSteer &&
      !text.startsWith("!");
    const runId = this.runId;
    const controller = new AbortController();
    this.preparingPrompt = controller;
    this.editor.setText(text);
    this.editor.disableSubmit = true;
    this.updateFooter();
    try {
      if (intervene && parseFileReferences(text).length)
        throw Error(
          "Attachments require Queue. Press Ctrl+X then Enter; your draft is preserved.",
        );
      const prepared = this.options.preparePrompt
        ? await this.options.preparePrompt(text, controller.signal)
        : { text };
      controller.signal.throwIfAborted();
      if (intervene && (prepared.images?.length || prepared.files?.length))
        throw Error(
          "Attachments require Queue. Press Ctrl+X then Enter; your draft is preserved.",
        );
      if (intervene && (!this.busy || runId !== this.runId))
        throw Error(
          "The run ended. Review your draft and send it as a new task.",
        );
      this.preparingPrompt = undefined;
      this.editor.disableSubmit = false;
      this.editor.setText("");
      if (intervene) {
        const id = await this.options.onSteer!(prepared.text, runId);
        if (typeof id === "string") {
          if (this.appliedInterventions.has(id))
            this.interventionState = "applied";
          else if (this.busy && this.runId === runId) {
            this.interventions.set(id, runId);
            this.interventionState = "pending";
          } else this.interventionState = "unapplied";
        }
        if (this.interventionState === "unapplied")
          this.notice(
            "Intervention not applied · review it in Activity before sending again",
          );
        else if (this.interventionState !== "applied")
          this.notice(
            "Intervention submitted · waiting for a model turn to apply it",
          );
      } else
        await this.options.onPrompt(
          prepared.text,
          prepared.images,
          prepared.files,
        );
    } catch (error) {
      if (!this.editor.getExpandedText()) this.editor.setText(text);
      if (!(error instanceof Error && error.name === "AbortError"))
        this.setError(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    } finally {
      if (this.preparingPrompt === controller) this.preparingPrompt = undefined;
      this.editor.disableSubmit = false;
      this.updateFooter();
    }
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
          ? this.options.onSteer
            ? "Message · intervene"
            : "Message · queued on send"
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
            ? this.options.onSteer
              ? "Enter intervene · Ctrl+X Enter queue · Ctrl+C stop"
              : "Ctrl+C stops · new prompts queue"
            : `Enter send · Ctrl+P commands · @ files${this.status.size ? " · " + [...this.status.values()].join(" · ") : ""}`,
    );
  }

  approve(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.disposed) return Promise.resolve(false);
    if (
      !this.visible ||
      this.approval ||
      this.dialog ||
      (this.modelPanel && this.panelYieldsToApproval)
    ) {
      return new Promise((resolve) => {
        const pending = { request, signal, resolve };
        this.pendingApprovals.push(pending);
        signal.addEventListener(
          "abort",
          () => {
            const index = this.pendingApprovals.indexOf(pending);
            if (index >= 0) {
              this.pendingApprovals.splice(index, 1);
              resolve(false);
              this.options.onStateChange?.();
            }
          },
          { once: true },
        );
        this.options.onStateChange?.();
        if (this.panelYieldsToApproval) this.modelController?.abort();
      });
    }
    return new Promise((resolve) => {
      const abort = () => this.answer(false);
      signal.addEventListener("abort", abort, { once: true });
      const panel = new ApprovalPanel(
        request,
        this.options.cwd,
        (value) => this.answer(value),
        () => this.tui.requestRender(),
        (width) =>
          Math.max(
            0,
            this.tui.terminal.rows -
              this.header.render(width).length -
              this.historyHint.render(width).length -
              (this.tui.terminal.rows < 18
                ? 0
                : this.editor.render(width).length) -
              Math.min(2, this.inputError.render(width).length) -
              this.footer.render(width).length -
              1,
          ),
      );
      this.approval = {
        resolve,
        cleanup: () => signal.removeEventListener("abort", abort),
        panel,
      };
      this.approvalSlot.addChild(panel);
      if (this.visible) this.tui.setFocus(panel);
      this.updateFooter();
      this.options.onStateChange?.();
      this.tui.requestRender();
    });
  }
  private presentApproval() {
    if (
      !this.visible ||
      this.approval ||
      this.modelPanel ||
      this.dialog ||
      this.disposed
    )
      return;
    const pending = this.pendingApprovals.shift();
    if (pending)
      void this.approve(pending.request, pending.signal).then(pending.resolve);
  }
  private answer(value: boolean) {
    const approval = this.approval;
    this.approval = undefined;
    if (approval) {
      if (this.parkedFocus === approval.panel)
        this.parkedFocus = this.modelPanel ?? this.editor;
      this.approvalSlot.clear();
      if (!this.disposed && this.visible)
        this.tui.setFocus(this.modelPanel ?? this.editor);
      approval.cleanup();
      approval.resolve(value);
    }
    this.nextDialog();
    this.presentApproval();
    this.updateFooter();
    this.options.onStateChange?.();
    if (!this.disposed) this.tui.requestRender();
  }
  dispose() {
    this.preparingPrompt?.abort();
    this.modelController?.abort();
    this.removeScheme?.();
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingApprovals.splice(0))
      pending.resolve(false);
    for (const page of this.pages.values()) page.dispose();
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
