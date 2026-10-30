import { randomUUID, createHash } from "node:crypto";
import { SessionWorkspace, type WorkspaceHandle } from "./session-workspace.ts";
import { attachedBackgroundSettled } from "./session-monitor.ts";
import { parseManualCommand } from "../../../packages/tui/src/manual-command.ts";
import type { AttachedWorkflows } from "./attached-workflows.ts";
import { openPluginExecution } from "../../../packages/tui/src/plugin-execution.ts";
import { SharedHostClient } from "../../../packages/host/src/client.ts";
import { ClientFiles } from "../../../packages/host/src/client-files.ts";
import { ClientConnection } from "../../../packages/client-core/src/connection.ts";
import { rpcTransientMethods } from "../../protocol/src/contracts.ts";
import type {
  HikaroView,
  HistoryDirection,
} from "../../../packages/tui/src/index.ts";
import { DraftSaver } from "../../../packages/tui/src/drafts.ts";
import {
  preparePrompt,
  attachmentReference,
} from "../../../packages/runtime/src/attachments.ts";
import type {
  AgentBackend,
  AgentEvent,
  Message,
  MessagePage,
} from "../../../packages/core/src/types.ts";

type AttachOptions = {
  cwd: string;
  home?: string;
  clientId?: string;
  session?: string;
  newSession?: boolean;
};
type AttachedHandle = WorkspaceHandle & {
  clientId: string;
  session(): import("../../core/src/types.ts").Session;
  refreshWorkflow(): void;
};
export async function attachTui(options: AttachOptions) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("--attach requires a terminal");
  const [{ createTerminal }, transport] = await Promise.all([
    import("../../tui/src/index.ts"),
    SharedHostClient.connect({
      ...options,
      clientId: options.clientId ?? "main",
    }),
  ]);
  const tui = createTerminal();
  const workspaceFiles = await ClientFiles.open(
    transport.endpoint.home,
    transport.endpoint.key,
    transport.scope,
  ).catch(async (error) => {
    await transport.close();
    throw error;
  });
  type SavedWorkspace = {
    sessions?: Array<{ id: string; clientId: string }>;
    open?: string[];
    selected?: string;
  };
  const saved = (await workspaceFiles.workspace().catch(async (error) => {
    await transport.close();
    throw error;
  })) as SavedWorkspace | null;
  const known = new Map<string, string>();
  try {
    if (
      saved !== null &&
      (typeof saved !== "object" ||
        Array.isArray(saved) ||
        (saved.sessions !== undefined && !Array.isArray(saved.sessions)) ||
        (saved.open !== undefined &&
          (!Array.isArray(saved.open) ||
            saved.open.length > 8 ||
            saved.open.some((id) => typeof id !== "string"))) ||
        (saved.selected !== undefined && typeof saved.selected !== "string"))
    )
      throw Error("Invalid saved workspace");
    const scopes = new Set<string>();
    for (const entry of saved?.sessions ?? []) {
      if (
        known.size >= 1024 ||
        typeof entry?.id !== "string" ||
        !entry.id ||
        entry.id.length > 128 ||
        typeof entry.clientId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(entry.clientId) ||
        known.has(entry.id) ||
        scopes.has(entry.clientId)
      )
        throw Error("Invalid saved workspace sessions");
      known.set(entry.id, entry.clientId);
      scopes.add(entry.clientId);
    }
  } catch (error) {
    await transport.close();
    throw error;
  }
  const { parseTuiPreferences } = await import("../../tui/src/preferences.ts");
  let workspacePreferences = await workspaceFiles
    .preferences()
    .then((value) => parseTuiPreferences(value ?? {}))
    .catch(async (error) => {
      await transport.close();
      throw error;
    });
  let exiting = false;
  let first = true;
  let workspace: SessionWorkspace;
  let removeWorkspaceInput = () => {};
  let savedWorkspace: Promise<void> = Promise.resolve();
  const persist = () => {
    const value = {
      sessions: [...known].map(([id, clientId]) => ({ id, clientId })),
      open: workspace.values().map((h) => h.id),
      selected: workspace.current?.id,
    };
    savedWorkspace = savedWorkspace
      .catch(() => {})
      .then(() => workspaceFiles.saveWorkspace(value));
    return savedWorkspace;
  };
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    removeWorkspaceInput();
    process.off("SIGTERM", leave);
    process.off("SIGHUP", leave);
    try {
      await persist();
    } finally {
      tui.stop({ preserveScreen: true });
      await workspace.dispose();
    }
  };
  const leave = () => {
    void shutdown().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  const open = async (id: string) => {
    const handle = (await workspace.open(id)) as AttachedHandle;
    await persist();
    return handle.session();
  };
  workspace = new SessionWorkspace(
    async (id) => {
      const initial = first;
      first = false;
      const clientId = initial
        ? transport.clientId
        : (known.get(id) ??
          `${transport.clientId.slice(0, 24)}-${id === "__new" ? randomUUID() : createHash("sha256").update(id).digest("hex").slice(0, 32)}`);
      const handle = await createAttachedSession(
        {
          ...options,
          clientId,
          session: initial || id === "__new" ? undefined : id,
          newSession: !initial && id === "__new",
        },
        {
          tui,
          workspace,
          leave,
          open,
          preferenceFiles: workspaceFiles,
          preferences: () => workspacePreferences,
          preferencesChanged: (value) => {
            workspacePreferences = value;
            for (const handle of workspace.values())
              handle.view.setPreferences(value);
          },
          transport: initial ? transport : undefined,
          close: async (current) => {
            await workspace.close(current);
            await persist();
          },
          removed: async (current) => {
            await workspace.forget(current);
            known.delete(current);
            await persist();
          },
          prepareRemoval: async (id) => {
            if (workspace.current?.id !== id) return false;
            const replacement = workspace
              .values()
              .find((handle) => handle.id !== id);
            await open(replacement?.id ?? "__new");
            return true;
          },
        },
      );
      known.set(handle.id, clientId);
      return handle;
    },
    (view) => {
      tui.setLayoutRoot(view.layout);
      tui.requestRender(true);
    },
    async () => {
      await persist();
      (workspace.current as AttachedHandle | undefined)?.refreshWorkflow();
    },
  );
  const { matchesKey } = await import("../../tui/src/primitives.ts");
  removeWorkspaceInput = tui.addInputListener((data) => {
    if (workspace.switching && matchesKey(data, "ctrl+d")) {
      leave();
      return { consume: true };
    }
    return undefined;
  });
  try {
    const primary = await workspace.open("__initial");
    for (const id of (workspacePreferences.resumeOnStart
      ? (saved?.open ?? [])
      : []
    ).slice(0, 8)) {
      if (
        typeof id !== "string" ||
        !known.has(id) ||
        workspace.get(id) ||
        known.get(id) === transport.clientId
      )
        continue;
      try {
        await workspace.open(id, false);
      } catch (error) {
        primary.view.notice(
          `Could not restore session ${id}: ${String(error)}`,
        );
      }
    }
    if (options.newSession) await open("__new");
    else if (options.session) await open(options.session);
    else if (
      workspacePreferences.resumeOnStart &&
      saved?.selected &&
      workspace.get(saved.selected)
    )
      await open(saved.selected);
    if (exiting) return;
    process.once("SIGTERM", leave);
    process.once("SIGHUP", leave);
    tui.start();
    tui.requestRender(true);
  } catch (error) {
    if (!exiting) {
      await shutdown();
      throw error;
    }
  }
}
async function createAttachedSession(
  options: AttachOptions,
  owner: {
    tui: import("../../tui/src/primitives.ts").TuiAltScreen;
    workspace: SessionWorkspace;
    leave(): void;
    open(id: string): Promise<import("../../core/src/types.ts").Session>;
    close(id: string): Promise<void>;
    removed(id: string): Promise<void>;
    prepareRemoval(id: string): Promise<boolean>;
    preferenceFiles: ClientFiles;
    preferences(): import("../../tui/src/preferences.ts").TuiPreferences;
    preferencesChanged(
      value: import("../../tui/src/preferences.ts").TuiPreferences,
    ): void;
    transport?: SharedHostClient;
  },
): Promise<AttachedHandle> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("--attach requires a terminal");
  const { openInteractive } = await import("./interactive-startup.ts");
  const {
    runtime: transport,
    view: [ui, workflowsModule],
  } = await openInteractive(
    Promise.all([
      import("../../../packages/tui/src/index.ts"),
      import("./attached-workflows.ts"),
    ]),
    owner.transport
      ? Promise.resolve(owner.transport)
      : SharedHostClient.connect({
          ...options,
          clientId: options.clientId ?? "main",
        }),
  );
  const { HikaroView } = ui;
  const { AttachedWorkflows } = workflowsModule;
  const files = await ClientFiles.open(
    transport.endpoint.home,
    transport.endpoint.key,
    transport.scope,
  ).catch(async (e) => {
    await transport.close();
    throw e;
  });
  const client = new ClientConnection(transport.scope, transport, {
    id: randomUUID,
    intents: files,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  const preferences = owner.preferences();
  const tui = owner.tui;
  let view: HikaroView;
  let workflows: AttachedWorkflows | undefined;
  let navigation:
    import("./attached-navigation.ts").AttachedNavigation | undefined;
  let catalog:
    | import("../../../packages/provider-pi/src/catalog.ts").ProviderCatalog
    | undefined;
  const configure = async (command: string, arg: string) => {
    if (!navigation) {
      const { AttachedNavigation } = await import("./attached-navigation.ts");
      navigation = new AttachedNavigation(
        client,
        view,
        owner.preferenceFiles,
        owner.preferences(),
        async () => {
          if (!catalog) {
            const [{ ProviderCatalog }, { KeychainCredentials }] =
              await Promise.all([
                import("../../../packages/provider-pi/src/catalog.ts"),
                import("../../../packages/provider-pi/src/credentials.ts"),
              ]);
            catalog = new ProviderCatalog(
              transport.endpoint.home,
              new KeychainCredentials(transport.endpoint.home),
            );
          }
          return catalog;
        },
        () => drafts.flush(),
        () => refresh(),
        {
          open: owner.open,
          create: () => owner.open("__new"),
          removed: owner.removed,
          prepareRemoval: owner.prepareRemoval,
          affected: (provider) =>
            owner.workspace
              .values()
              .filter((handle) => handle.provider?.() === provider)
              .map((handle) => handle.title()),
          credentialBlocked: (provider) =>
            owner.workspace
              .values()
              .some(
                (handle) =>
                  handle.provider?.() === provider &&
                  (handle.state() === "Disconnected" || handle.view.isBusy),
              )
              ? "A monitored session is working or its host state is uncertain. Wait before changing its provider credentials."
              : undefined,
          credentialsChanged: () => {
            for (const handle of owner.workspace.values())
              handle.view.refreshWorkspace("Context");
          },
          preferences: owner.preferences,
          preferencesChanged: owner.preferencesChanged,
        },
      );
    }
    await workflows!.withMenu(() => navigation!.command(command, arg));
  };
  let exiting = false,
    loading = false,
    loadEpoch = 0,
    lastEvent = 0;
  let sessionId: string | undefined;
  let sourceOwner: string | null | undefined;
  const refreshSources = () => {
    const state = client.status;
    if (
      !view ||
      !state.canAct ||
      !sessionId ||
      sourceOwner === state.hostInstanceId
    )
      return;
    sourceOwner = state.hostInstanceId;
    const host = sourceOwner,
      id = sessionId;
    void import("./workbench-sources.ts")
      .then(({ attachedWorkspaceSources }) => {
        if (
          !exiting &&
          client.status.canAct &&
          client.status.hostInstanceId === host &&
          sessionId === id
        )
          view.setWorkspaceSources(attachedWorkspaceSources(view, client, id));
      })
      .catch(fail);
  };
  let historyRows: Array<{ seq: number; message: Message }> = [];
  const messageSources = new WeakMap<
    Message,
    { sessionId: string; seq: number }
  >();
  const rememberMessages = (page: MessagePage, sessionId: string) => {
    for (const row of page.items)
      messageSources.set(row.message, { sessionId, seq: row.seq });
    return page.items.map((row) => row.message);
  };
  let buffer: AgentEvent[] = [];
  let bufferBytes = 0;
  const listeners = new Set<(event: AgentEvent) => void>();
  const approvals = new Map<string, AbortController>();
  const fail = (e: unknown) => view?.setError(String(e));
  const drafts = new DraftSaver((id, text) => files.saveDraft(id, text), fail);
  const backend: AgentBackend = {
    async prompt(text, images, _origin, files) {
      if (files?.length && !client.supportsFiles)
        throw Error(
          "This host does not support general file attachments; update it first",
        );
      if (
        files?.length &&
        Buffer.byteLength(JSON.stringify({ text, images, files })) > 900000
      )
        throw Error(
          "Attached prompts must fit the host's 1 MiB frame; use smaller files or the standalone TUI",
        );
      await client.request("prompt", {
        text,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
      });
    },
    cancel() {
      void client.request("cancel").catch(fail);
    },
    steer(text) {
      void client.request("steer", { text }).catch(fail);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const syncApprovals = (state = client.status) => {
    const live = state.canAct ? state.approvals : [];
    for (const [id, controller] of approvals)
      if (!live.some((a) => a.id === id)) {
        controller.abort();
        approvals.delete(id);
      }
    // The existing fixed panel presents one approval at a time.
    if (loading || approvals.size || !view || !live.length) return;
    const request = live[0]!;
    const controller = new AbortController();
    approvals.set(request.id, controller);
    void view.approve(request, controller.signal).then(async (allow) => {
      if (controller.signal.aborted) return;
      try {
        await client.request("approval.respond", { id: request.id, allow });
      } catch (e) {
        fail(e);
      } finally {
        if (approvals.get(request.id) === controller)
          approvals.delete(request.id);
      }
    });
  };
  async function history(direction: HistoryDirection = "latest") {
    const p: Record<string, unknown> = {
      limit: 20,
      sessionId: client.state.session?.id,
    };
    if (direction === "older" && historyRows.length)
      p.before = historyRows[0]!.seq;
    if (direction === "newer" && historyRows.length)
      p.after = historyRows.at(-1)!.seq;
    const page = (await client.request("messages.read", p)) as MessagePage;
    historyRows = page.items;
    return { ...page, messages: rememberMessages(page, p.sessionId as string) };
  }
  async function refresh() {
    if (exiting) return;
    const epoch = ++loadEpoch;
    loading = true;
    buffer = [];
    bufferBytes = 0;
    const next = client.state.session?.id;
    if (!next) {
      loading = false;
      sessionId = undefined;
      view.showMessages([]);
      view.restoreExecution(client.state);
      return;
    }
    try {
      const page = (await client.request("messages.read", {
        sessionId: next,
        limit: 20,
      })) as MessagePage;
      const changed = sessionId !== next;
      let draft: string | undefined;
      if (changed) {
        await drafts.flush();
        draft = await files.draft(next);
      }
      if (
        epoch !== loadEpoch ||
        !client.state.canAct ||
        next !== client.state.session?.id
      )
        return;
      historyRows = page.items;
      view.showMessages(rememberMessages(page, next), page);
      lastEvent = page.items.at(-1)?.seq ?? 0;
      for (const event of buffer)
        if (event.seq > lastEvent) {
          lastEvent = event.seq;
          view.event(event);
        }
      view.restoreExecution(client.state);
      const selection = client.state.session?.modelSelection;
      if (selection) view.setModel(`${selection.provider}/${selection.model}`);
      sessionId = next;
      refreshSources();
      if (draft !== undefined) view.editor.setText(draft);
      loading = false;
      buffer = [];
      bufferBytes = 0;
      syncApprovals();
      void workflows?.refresh();
      owner.workspace.refresh();
    } catch (e) {
      if (epoch === loadEpoch) {
        loading = false;
        fail(e);
      }
    }
  }
  const offRaw = transport.observe((frame) => {
    if (!view || frame.scope !== transport.scope) return;
    if (frame.type === "connection.replaced") {
      view.setError(
        "This view was attached elsewhere. Use a different --client-id for simultaneous views.",
      );
      return;
    }
    if (frame.type === "error" || frame.type === "operation.failed") {
      view.setError(
        `Host: ${String(frame.error).slice(0, 2000)}. Inspect /status before retrying.`,
      );
      return;
    }
    if (
      frame.type === "response" &&
      frame.result &&
      typeof frame.result.revision === "number" &&
      "approvals" in frame.result
    ) {
      void refresh();
      return;
    }
    if (frame.type !== "event") return;
    const state = client.status;
    if (!state.canAct || frame.event.sessionId !== state.session?.id) return;
    const event = frame.event as AgentEvent;
    if (event.type === "message")
      messageSources.set(event.data.message as Message, {
        sessionId: event.sessionId,
        seq: event.seq,
      });
    if (loading) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (buffer.length >= 128 || bufferBytes + bytes > 1_048_576) {
        void refresh();
        return;
      }
      buffer.push(event);
      bufferBytes += bytes;
    } else if (event.seq > lastEvent) {
      lastEvent = event.seq;
      for (const fn of listeners) fn(event);
    }
    owner.workspace.refresh(event.sessionId);
    if (["tool.start", "tool.end", "run.end"].includes(event.type))
      void workflows?.refresh();
  });
  const offState = client.subscribe(() => {
    if (!view) return;
    const state = client.status;
    view.setStatus({
      connection: state.canAct
        ? "connected"
        : state.connection === "offline"
          ? "disconnected"
          : "synchronizing",
    });
    if (!state.canAct) {
      if (state.connection === "offline") {
        workflows?.disconnected();
        navigation?.disconnected();
      }
      for (const c of approvals.values()) c.abort();
      approvals.clear();
    }
    if (state.connection === "offline") {
      loadEpoch++;
      loading = false;
      view.restoreExecution({
        busy: false,
        stream: "",
        streamTruncated: false,
      });
    } else syncApprovals(state);
    owner.workspace.refresh();
  });
  const offConnection = transport.onConnection((connected) => {
    if (connected) void client.connected().catch(fail);
    else client.disconnected();
  });
  let backgroundSettled = false;
  const close = async () => {
    if (exiting) return;
    exiting = true;
    loadEpoch++;
    for (const controller of approvals.values()) controller.abort();
    approvals.clear();
    offConnection();
    offState();
    offRaw();
    workflows?.close();
    try {
      if (sessionId) drafts.update(sessionId, view.editor.getExpandedText());
      await drafts.flush();
      // Explicitly release idle scopes; a closed socket alone retains its host slot.
      // Busy/unknown scopes stay recoverable, with pending approvals at the host.
      if (
        client.status.canAct &&
        !client.status.busy &&
        !client.status.approvals.length &&
        sessionId &&
        (await attachedBackgroundSettled(client, sessionId))
      )
        await client
          .request("client.detach", { cancel: false })
          .catch(() => {});
    } finally {
      client.close();
      view?.dispose();
      await transport.close();
    }
  };
  let submittedDraft = "";
  view = new HikaroView(tui, {
    active: false,
    cwd: transport.endpoint.cwd,
    model: "shared host",
    onExit: owner.leave,
    onSelectSession: async (id) => {
      await owner.open(id);
    },
    onStateChange: () => owner.workspace.refresh(),
    onSteer: async (text, expectedRunId) => {
      const state = client.status;
      if (!state.canAct || !state.session || !expectedRunId)
        throw Error("Host is disconnected or the run changed; draft retained");
      const result = await client.request("steer", {
        text,
        sessionId: state.session.id,
        expectedRunId,
      });
      if (
        result &&
        typeof result === "object" &&
        "steeringId" in result &&
        typeof result.steeringId === "string"
      )
        return result.steeringId;
    },
    onCancelRun: async (runId) => {
      const state = client.status;
      if (!state.canAct || !state.session)
        throw Error("Host is disconnected; refresh before cancelling");
      await client.request("run.cancel", {
        sessionId: state.session.id,
        runId,
      });
    },
    detachOnCtrlD: true,
    commands: [
      {
        name: "close",
        description: "Close an idle session; keep running work monitored",
      },
      {
        name: "storage",
        description: "Preview host session storage and clean snapshots",
      },
      { name: "search", description: "Search full messages in this session" },
      ...[
        "recovery",
        "export",
        "plugins",
        "sessions",
        "resume",
        "model",
        "settings",
        "permissions",
        "context",
        "thinking",
        "speed",
        "resources",
      ].map((name) => ({ name, description: "Open " + name })),
      { name: "changes", description: "Review and roll back host edits" },
      { name: "tasks", description: "Manage host execution" },
      { name: "plan", description: "Read-only planning and plan review" },
    ],
    onDraftChange: (text) => {
      if (sessionId) drafts.update(sessionId, text);
    },
    previewAttachment: async (path, signal) => {
      const { previewAttachment } =
        await import("../../runtime/src/attachments.ts");
      if (!sessionId)
        throw Error("Select a session before previewing an attachment");
      return previewAttachment(path, {
        cwd: transport.endpoint.cwd,
        signal,
        approve: (file) =>
          view.approve(
            {
              id: randomUUID(),
              sessionId: sessionId!,
              tool: "preview_attachment",
              arguments: { path: file.path },
              reason: `Read ${file.path} for local preview only; nothing is sent to the host model`,
              capability: { kind: "file", path: file.path, write: false },
            },
            signal,
          ),
      });
    },
    preparePrompt: async (text, signal) => {
      if (!client.state.canAct || loading)
        throw Error("Host is disconnected or synchronizing; draft stays local");
      submittedDraft = text;
      if (text.startsWith("!")) return { text };
      return preparePrompt(text, {
        cwd: transport.endpoint.cwd,
        signal,
        supportsImages: true,
        approve: (file) =>
          view.approve(
            {
              id: randomUUID(),
              sessionId: sessionId!,
              tool: "attach_file",
              arguments: { path: file.path },
              reason: `Send ${file.path} to the selected host model`,
              capability: { kind: "file", path: file.path, write: false },
            },
            signal,
          ),
      });
    },
    onPrompt: async (text, images, files) => {
      try {
        const queued = client.state.busy;
        if (text.startsWith("!")) {
          const result = await client.request("tool.manual", {
            sessionId: client.state.session?.id,
            ...parseManualCommand(text),
          });
          await refresh();
          view.notice(
            result && typeof result === "object" && "duplicate" in result
              ? "Command already received; inspect history and receipts."
              : (result as { isError?: boolean }).isError
                ? "Manual command failed. Inspect output and status above."
                : "Manual command finished. Inspect output and status above.",
          );
          return;
        }
        await backend.prompt(text, images, undefined, files);
        if (queued)
          view.notice(
            "Message queued on host. Open Activity to manage pending messages.",
          );
      } catch (e) {
        if (!view.editor.getExpandedText()) view.editor.setText(submittedDraft);
        throw e;
      }
    },
    onHistory: history,
    onReadMessage: async (message, offset, limit) => {
      const source = messageSources.get(message);
      const epoch = loadEpoch;
      if (
        !source ||
        !client.state.canAct ||
        source.sessionId !== client.state.session?.id
      )
        throw Error(
          "Message is no longer in the selected session. Reload history.",
        );
      const content = (await client.request("messages.content", {
        ...source,
        field: "text",
        offset,
        limit,
      })) as { data: string };
      if (
        epoch !== loadEpoch ||
        !client.state.canAct ||
        source.sessionId !== client.state.session?.id
      )
        throw Error(
          "Session or connection changed while reading. Reload history.",
        );
      return content.data;
    },
    onCommand: async (text) => {
      const [command, ...parts] = text.trim().split(/\s+/);
      const rest = parts.join(" ");
      switch (command) {
        case "/search": {
          if (!client.supports("messages.search"))
            throw Error("Upgrade the host to search message history.");
          const { openMessageSearch } =
            await import("../../../packages/tui/src/message-search.ts");
          const sessionId = client.state.session?.id;
          if (!sessionId) throw Error("No session selected");
          await openMessageSearch(
            view,
            rest,
            async (query, before) =>
              (await client.request("messages.search", {
                sessionId,
                query,
                before,
              })) as import("../../../packages/protocol/src/contracts.ts").MessageSearchPage,
            async (request) =>
              (await client.request("messages.content", {
                sessionId,
                ...request,
              })) as import("../../../packages/tui/src/message-search.ts").SearchContent,
          );
          return;
        }
        case "/changes":
        case "/tasks":
        case "/plan":
          await workflows!.command(command, rest);
          return;
        case "/quit":
          owner.leave();
          return;
        case "/help":
          return "Shared host: /recovery, /export, /plugins, ![--unrestricted] COMMAND (host approvals apply), /search [text], /changes, /tasks, /tasks history [RUN_ID], /plan [TASK], /plan cancel, /plan history, /plan progress · host workflows. /sessions [query], /resume ID, /new, /rename title, /compact, /fork, /steer text, /status, /model [PROVIDER/MODEL] and provider accounts, /settings, /permissions, /context [default], /thinking [default], /speed [default], /resources [query], /storage, /attach PATH. Enter intervenes during a run; Ctrl+X Enter queues. Ctrl+P actions; Ctrl+O sessions. Ctrl+C stops the selected task; Ctrl+D detaches. Local files use the existing @ completion.";
        case "/storage": {
          const { storageCommand } =
            await import("../../../packages/tui/src/storage.ts");
          const id = client.status.session?.id;
          if (!id || !client.status.canAct)
            throw Error("Select a connected host session first");
          if (
            !client.supports("storage.preview") ||
            !client.supports("storage.cleanup")
          )
            throw Error(
              "This host does not support storage management; update the host first",
            );
          return storageCommand(rest, {
            preview: async () =>
              (await client.request("storage.preview", {
                sessionId: id,
              })) as import("../../../packages/tui/src/storage.ts").StoragePreview,
            clean: async (token) =>
              (await client.request("storage.cleanup", {
                sessionId: id,
                token,
              })) as { files: number; bytes: number },
          });
        }
        case "/status":
          return JSON.stringify(
            {
              ...client.status,
              budgetScope:
                "Current host Agent lifetime. Recreating the Agent or restarting the host resets usage and limits; reconnecting a client does not.",
              stream: undefined,
              events: undefined,
              approvals: client.state.approvals.map((a) => a.id),
              receipts: client.receipts.filter((r) =>
                ["unknown", "acknowledged"].includes(r.status),
              ),
            },
            null,
            2,
          );
        case "/recovery":
        case "/export":
        case "/plugins":
        case "/sessions":
        case "/resume":
        case "/login":
        case "/logout":
        case "/model":
        case "/settings":
        case "/permissions":
        case "/context":
        case "/thinking":
        case "/speed":
        case "/resources":
          await configure(command, rest);
          return;
        case "/close":
          await owner.close(sessionId!);
          return;
        case "/new":
          await drafts.flush();
          await owner.open("__new");
          return;
        case "/rename":
          await client.request("session.rename", { title: rest });
          return;
        case "/compact":
          await client.request("session.compact");
          return;
        case "/fork": {
          const original = sessionId!;
          const fork = (await client.request("session.fork")) as { id: string };
          await client.request("session.resume", { sessionId: original });
          await owner.open(fork.id);
          return;
        }
        case "/steer":
          await client.request("steer", { text: rest });
          return;
        case "/paste-image": {
          const target = client.state.session?.id;
          const draft = view.editor.getExpandedText();
          const { saveClipboardImage } =
            await import("../../../packages/runtime/src/clipboard-image.ts");
          const path = await saveClipboardImage();
          if (exiting) return;
          if (
            !client.state.canAct ||
            client.state.session?.id !== target ||
            view.editor.getExpandedText() !== draft
          )
            return `Input or connection changed; clipboard image saved at ${path}. Use /attach PATH to add it when ready.`;
          view.editor.setText(attachmentReference(path) + " ");
          return "Clipboard image attached. Add your question and press Enter. The private temporary file is retained for draft recovery.";
        }
        case "/attach":
          view.editor.setText(attachmentReference(text.slice(7)));
          return;
        case "/reconnect":
          await client.connected();
          await client.reconcile();
          return;
        case "/plugin-stop":
          await client.request("plugins.cancel", {
            sessionId: client.state.session?.id,
            invocationId: rest.trim(),
          });
          return "Plugin cancellation requested; wait for execution to settle.";
        default: {
          const sessionId = client.state.session?.id;
          return openPluginExecution(
            view,
            command!.slice(1),
            async (invocationId) => {
              const result = await client.request("plugins.invoke", {
                sessionId,
                invocationId,
                name: command!.slice(1),
                args: rest,
              });
              if (result && typeof result === "object" && "duplicate" in result)
                return "Command already received; inspect receipts before retrying.";
              return (result as { text: string }).text;
            },
            client.supports("plugins.cancel")
              ? (invocationId) =>
                  client.request("plugins.cancel", { sessionId, invocationId })
              : undefined,
          );
        }
      }
    },
  });
  view.setActive(false);
  workflows = new AttachedWorkflows(client, view, transport.endpoint.cwd, {
    polling: false,
    active: () => view.active,
    attentionChanged: () => owner.workspace.refresh(),
  });
  view.setPreferences(preferences);
  view.bind(backend);
  view.setStatus({
    connection: client.status.canAct ? "connected" : "synchronizing",
  });
  view.setPermissionLabel("Host owns task approvals");
  try {
    await client.connected();
    if (options.session)
      await client.request("session.resume", { sessionId: options.session });
    else if (
      options.newSession ||
      !preferences.resumeOnStart ||
      !client.state.session
    )
      await client.request("session.create");
    await refresh();
    view.notice(
      "Attached to shared host. Ctrl+D detaches; the task continues.",
    );
    view.startTheme();
    const fixedId = client.status.session!.id;
    refreshSources();
    return {
      id: fixedId,
      view,
      clientId: transport.clientId,
      session: () =>
        client.status.session as import("../../core/src/types.ts").Session,
      title: () => client.status.session?.title ?? fixedId,
      provider: () => client.status.session?.modelSelection?.provider,
      attention: () => workflows?.attentionCount ?? 0,
      refreshWorkflow: () => {
        void workflows?.refresh();
      },
      state: () =>
        !client.status.canAct
          ? "Disconnected"
          : client.status.approvals.length
            ? "Waiting for approval"
            : workflows?.attentionCount
              ? "Waiting for input"
              : client.status.busy
                ? "Working"
                : client.status.runStatus === "failed"
                  ? "Failed"
                  : client.status.runStatus === "cancelled"
                    ? "Stopped"
                    : "Ready",
      canClose: () =>
        backgroundSettled &&
        client.status.canAct &&
        !client.status.busy &&
        !client.status.approvals.length &&
        !client.receipts.some(
          (receipt) =>
            !rpcTransientMethods.has(receipt.method) &&
            ["pending", "acknowledged", "unknown"].includes(receipt.status),
        ),
      prepareClose: async () => {
        backgroundSettled = false;
        if (client.status.canAct) {
          await client.reconcile();
          backgroundSettled = await attachedBackgroundSettled(client, fixedId);
        }
      },
      flush: async () => {
        if (sessionId) drafts.update(sessionId, view.editor.getExpandedText());
        await drafts.flush();
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
