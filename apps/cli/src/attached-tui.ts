import { randomUUID } from "node:crypto";
import { parseManualCommand } from "../../../packages/tui/src/manual-command.ts";
import type { AttachedWorkflows } from "./attached-workflows.ts";
import { openPluginExecution } from "../../../packages/tui/src/plugin-execution.ts";
import { SharedHostClient } from "../../../packages/host/src/client.ts";
import { ClientFiles } from "../../../packages/host/src/client-files.ts";
import { ClientConnection } from "../../../packages/client-core/src/connection.ts";
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

export async function attachTui(options: {
  cwd: string;
  home?: string;
  clientId?: string;
  session?: string;
  newSession?: boolean;
}) {
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
    SharedHostClient.connect({
      ...options,
      clientId: options.clientId ?? "main",
    }),
  );
  const { createTerminal, HikaroView } = ui;
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
  const { parseTuiPreferences } =
    await import("../../../packages/tui/src/preferences.ts");
  const preferences = await files
    .preferences()
    .then((value) => parseTuiPreferences(value ?? {}))
    .catch(async (error) => {
      client.close();
      await transport.close();
      throw error;
    });
  const tui = createTerminal();
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
        files,
        preferences,
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
      );
    }
    await workflows!.withMenu(() => navigation!.command(command, arg));
  };
  let exiting = false,
    loading = false,
    loadEpoch = 0,
    lastEvent = 0;
  let sessionId: string | undefined;
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
      if (draft !== undefined) view.editor.setText(draft);
      loading = false;
      buffer = [];
      bufferBytes = 0;
      syncApprovals();
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
  });
  const offState = client.subscribe(() => {
    if (!view) return;
    const state = client.status;
    view.setInfo(
      state.canAct
        ? `Shared host · ${state.session?.id.slice(0, 8) ?? "no session"}`
        : "Host disconnected / synchronizing · draft stays local",
    );
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
  });
  const offConnection = transport.onConnection((connected) => {
    if (connected) void client.connected().catch(fail);
    else client.disconnected();
  });
  const leave = () => {
    if (exiting) return;
    exiting = true;
    loadEpoch++;
    for (const c of approvals.values()) c.abort();
    approvals.clear();
    offConnection();
    offState();
    offRaw();
    workflows?.close();
    client.close();
    view?.dispose();
    tui.stop({ preserveScreen: true });
    process.off("SIGTERM", leave);
    process.off("SIGHUP", leave);
    void drafts
      .flush()
      .catch((e) => console.error(String(e)))
      .finally(() => transport.close());
  };
  let submittedDraft = "";
  view = new HikaroView(tui, {
    cwd: transport.endpoint.cwd,
    model: "shared host",
    onExit: leave,
    detachOnCtrlD: true,
    commands: [
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
        "login",
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
            "Message queued on host. Use /tasks to manage pending messages.",
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
            async (seq, offset) =>
              (await client.request("messages.content", {
                sessionId,
                seq,
                field: "text",
                offset,
                limit: 16000,
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
          leave();
          return;
        case "/help":
          return "Shared host: /recovery, /export, /plugins, ![--unrestricted] COMMAND (host approvals apply), /search [text], /changes, /tasks, /tasks history [RUN_ID], /plan [TASK], /plan cancel, /plan history, /plan progress · host workflows. /sessions [query], /resume ID, /new, /rename title, /compact, /fork, /steer text, /status, /access, /share DEVICE view|control|off, /model [PROVIDER/MODEL], /login, /settings, /permissions, /context [default], /thinking [default], /speed [default], /resources [query], /storage, /attach PATH. Ctrl+C stops the selected task; Ctrl+D detaches. Local files use the existing @ completion.";
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
        case "/model":
        case "/settings":
        case "/permissions":
        case "/context":
        case "/thinking":
        case "/speed":
        case "/resources":
          await configure(command, rest);
          return;
        case "/new":
          await drafts.flush();
          await client.request("session.create");
          return;
        case "/rename":
          await client.request("session.rename", { title: rest });
          return;
        case "/compact":
          await client.request("session.compact");
          return;
        case "/fork":
          await client.request("session.fork");
          return;
        case "/steer":
          await client.request("steer", { text: rest });
          return;
        case "/access":
          return JSON.stringify(
            await client.request("session.access.read"),
            null,
            2,
          );
        case "/share": {
          const [deviceId, role] = parts;
          if (!deviceId || !["view", "control", "off"].includes(role ?? ""))
            throw Error("Use /share DEVICE view|control|off");
          await client.request("session.access", {
            deviceId,
            role: role === "off" ? null : role,
          });
          return "Session access updated.";
        }
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
  workflows = new AttachedWorkflows(client, view, transport.endpoint.cwd);
  view.setPreferences(preferences);
  view.bind(backend);
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
    tui.setLayoutRoot(view.layout);
    tui.setFocus(view.editor);
    tui.start();
    // Session, history and draft are ready; do not wait for a throttled frame
    // left over from the connection's earlier status updates.
    tui.requestRender(true);
    view.startTheme();
    process.once("SIGTERM", leave);
    process.once("SIGHUP", leave);
  } catch (e) {
    leave();
    throw e;
  }
}
