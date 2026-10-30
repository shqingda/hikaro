import { execFile } from "node:child_process";
import { openPluginExecution } from "../../tui/src/plugin-execution.ts";
import { parseManualCommand } from "../../tui/src/manual-command.ts";
import { Runtime, type RuntimeOptions } from "../../runtime/src/index.ts";
import type { EndpointCapabilities } from "../../core/src/types.ts";
import { SessionWorkspace, type WorkspaceHandle } from "./session-workspace.ts";
import { backgroundWorkSettled } from "./session-monitor.ts";

type StartupFlags = {
  session?: string;
  continue?: boolean;
  new?: boolean;
  demo?: boolean;
  provider?: string;
  model?: string;
  "base-url"?: string;
};
export async function nativeTui(
  options: Omit<RuntimeOptions, "approve">,
  values: StartupFlags,
  endpointCapabilities?: EndpointCapabilities,
) {
  let workspace: SessionWorkspace;
  let exiting = false;
  let removeWorkspaceInput = () => {};
  const { loadPermissionMode, permissionOptions } =
    await import("../../../packages/runtime/src/permissions.ts");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const permissionMode = await loadPermissionMode(
    options.home ?? join(homedir(), ".hikaro"),
    options.cwd,
  );
  const { openInteractive } = await import("./interactive-startup.ts");
  // Start the storage worker before evaluating the TUI's synchronous module
  // graph, so schema initialization can progress while the main thread loads UI.
  const { SQLiteStore } =
    await import("../../../packages/storage/src/index.ts");
  const startupStore = await SQLiteStore.open(
    join(options.home ?? join(homedir(), ".hikaro"), "sessions.sqlite"),
  );
  let runtime: Runtime;
  const opened = await openInteractive(
    import("../../../packages/tui/src/index.ts"),
    Runtime.open(
      {
        ...options,
        permissionMode,
        approve: async (r, signal) => {
          const id = runtime.approvalAuthority(r.sessionId);
          const handle = workspace.get(id) ?? (await workspace.open(id, false));
          if (exiting || signal.aborted) return false;
          return handle.view.approve(r, signal);
        },
        askUser: (questions, signal, executionSessionId, scope) =>
          localQuestions.ask(questions, signal, executionSessionId, scope),
      },
      startupStore,
    ).catch(async (error) => {
      await startupStore.close();
      throw error;
    }),
  );
  runtime = opened.runtime;
  const ui = opened.view;
  const { createTerminal, HikaroView } = ui;
  const tui = createTerminal();
  const { LocalQuestions } = await import("./local-questions.ts");
  const localQuestions = new LocalQuestions(
    runtime,
    () => workspace.current!.view,
  );
  const { loadTuiPreferences, saveTuiPreferences } =
    await import("../../../packages/tui/src/preferences.ts");
  let preferences = await loadTuiPreferences(runtime.options.home!);
  const { selectInitialSession } = await import("./startup.ts");
  let initialSession: Awaited<ReturnType<typeof runtime.session>>;
  try {
    initialSession = await selectInitialSession(
      runtime,
      {
        session: values.session,
        continue: values.continue,
        new: values.new,
        demo: values.demo,
        provider: values.provider,
        model: values.model,
        baseUrl: values["base-url"],
        endpointCapabilities,
      },
      preferences,
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    removeWorkspaceInput();
    localQuestions.close();
    for (const handle of workspace.values())
      (await runtime.agent(await runtime.session(handle.id))).cancel(true);
    tui.stop({ preserveScreen: true });
    process.off("SIGTERM", exit);
    process.off("SIGHUP", exit);
    try {
      await workspace.dispose();
    } finally {
      await runtime.close(() => localQuestions.ready());
    }
    console.log("\nContinue: pnpm start · New session: pnpm start --new");
  };
  const exit = () => {
    void shutdown().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  workspace = new SessionWorkspace(
    createSession,
    (view) => {
      localQuestions.invalidate();
      tui.setLayoutRoot(view.layout);
      tui.requestRender(true);
    },
    async (id) => {
      if (exiting) return;
      await runtime.store.rememberSession(id);
      if (!exiting) await localQuestions.select(id);
    },
  );
  const { matchesKey } = await import("../../tui/src/primitives.ts");
  removeWorkspaceInput = tui.addInputListener((data) => {
    if (workspace.switching && matchesKey(data, "ctrl+d")) {
      exit();
      return { consume: true };
    }
    return undefined;
  });
  async function createSession(id: string): Promise<WorkspaceHandle> {
    let view: import("../../tui/src/index.ts").HikaroView;
    let session = await runtime.session(id);
    let disposed = false;
    let agent: Awaited<ReturnType<typeof runtime.agent>>;
    let promptWork: Promise<void> | undefined;
    try {
      agent = await runtime.agent(session);
    } catch (error) {
      throw error;
    }
    const { DraftSaver } = await import("../../../packages/tui/src/drafts.ts");
    let draftSessionId = session.id;
    const drafts = new DraftSaver(
      (id, text) => runtime.store.saveDraft(id, text),
      (error) => view.setError(`Draft autosave failed: ${String(error)}`),
    );
    let historyPage = await runtime.store.messagePage(session.id, {
      limit: 20,
    });
    const history = async (direction: "older" | "newer" | "latest") => {
      historyPage = await runtime.store.messagePage(session.id, {
        limit: 20,
        ...(direction === "older"
          ? { before: historyPage.items[0]?.seq }
          : direction === "newer"
            ? { after: historyPage.items.at(-1)?.seq }
            : {}),
      });
      return {
        messages: historyPage.items.map((i) => i.message),
        hasOlder: historyPage.hasOlder,
        hasNewer: historyPage.hasNewer,
      };
    };
    let removeStatus = () => {};
    let gitBranch = "";
    const readGit = (args: string[]) =>
      new Promise<string>((resolve) =>
        execFile(
          "git",
          args,
          { cwd: options.cwd, timeout: 1000, maxBuffer: 32000 },
          (error, stdout) => resolve(error ? "" : stdout.trim()),
        ),
      );
    const updateStatus = () => {
      view.setPermissionLabel(
        permissionOptions.find(
          (option) => option.value === runtime.permissionMode,
        )!.label +
          (runtime.planning.get(session.id).active ? " · Plan read-only" : ""),
      );
      const preferences = agent.options.session.modelSelection?.settings ?? {};
      const usage = agent.usage;
      view.setStatus({
        cwd: options.cwd,
        branch: gitBranch,
        usage: { ...usage },
        contextWindow: agent.options.provider.contextWindow,
        reasoning: preferences.reasoning ?? "auto",
        speed: preferences.speed,
      });
    };
    const reviewCurrentPlan = async () => {
      while (!agent.busy) {
        await runtime.planning.load(session.id, true);
        const state = runtime.planning.get(session.id);
        if (!state.active || !state.plan) return;
        const { reviewPlan } =
          await import("../../../packages/tui/src/planning.ts");
        const result = await reviewPlan(view, state.plan);
        if (result.action === "keep") {
          view.notice("Plan kept read-only. Use /plan to review again.");
          return;
        }
        if (result.action === "revise") {
          await runtime.setPlanning(session, true);
          await agent.prompt(`Revise the plan: ${result.text}`);
          continue;
        }
        const approved = await runtime.approvePlan(session, result.id);
        updateStatus();
        const { planExecutionPrompt } =
          await import("../../../packages/runtime/src/planning.ts");
        view.notice(
          "Plan approved. Starting execution under the current permissions.",
        );
        await agent.prompt(planExecutionPrompt(approved));
        return;
      }
    };
    const executionReaders = new Set<AbortController>();
    let sessionTransitions = 0;
    const bind = async (next: typeof session) => {
      if (next.id !== session.id) {
        await workspace.open(next.id);
        return;
      }
      if (agent.busy) throw Error("Cancel the active run first");
      sessionTransitions++;
      for (const reader of executionReaders) reader.abort();
      try {
        // Fence slow /questions reads before any part of the visible session changes.
        if (view.active) localQuestions.invalidate();
        if (await runtime.store.session(draftSessionId))
          drafts.update(draftSessionId, view.editor.getExpandedText());
        await drafts.flush();
        session = next;
        await runtime.store.rememberSession(next.id);
        agent = await runtime.agent(next);
        view.bind(agent);
        view.setModel(
          agent.options.provider.id + "/" + agent.options.provider.model,
        );
        removeStatus();
        removeStatus = agent.subscribe((event) => {
          if (event.type === "run.end") updateStatus();
        });
        updateStatus();
        const page = await history("latest");
        view.showMessages(page.messages, page);
        const savedDraft = await drafts.restore(draftSessionId, next.id, (id) =>
          runtime.store.draft(id),
        );
        if (savedDraft !== undefined) {
          draftSessionId = next.id;
          view.editor.setText(savedDraft);
        }
        if (view.active) await localQuestions.select(next.id);
      } finally {
        sessionTransitions--;
      }
    };
    const applyPreferences = async (next: typeof preferences) => {
      preferences = await saveTuiPreferences(runtime.options.home!, next);
      for (const handle of workspace.values())
        handle.view.setPreferences(preferences);
      if (!agent.busy) {
        historyPage = await runtime.store.messagePage(session.id, {
          limit: 20,
          ...(historyPage.hasNewer && historyPage.items.length
            ? { before: historyPage.items.at(-1)!.seq + 1 }
            : {}),
        });
        view.showMessages(
          historyPage.items.map((i) => i.message),
          historyPage,
        );
      }
      updateStatus();
    };
    view = new HikaroView(tui, {
      active: false,
      cwd: options.cwd,
      model: `${agent.options.provider.id}/${agent.options.provider.model}`,
      onPreferences: (patch) => applyPreferences({ ...preferences, ...patch }),
      onDraftChange: (text) => drafts.update(draftSessionId, text),
      previewAttachment: async (path, signal) => {
        const { previewAttachment } =
          await import("../../runtime/src/attachments.ts");
        return previewAttachment(path, {
          cwd: options.cwd,
          signal,
          approve: (file) =>
            view.approve(
              {
                id: crypto.randomUUID(),
                sessionId: session.id,
                tool: "preview_attachment",
                arguments: { path: file.path },
                reason: `Read ${file.path} for local preview only; nothing is sent to the model`,
                capability: { kind: "file", path: file.path, write: false },
              },
              signal,
            ),
        });
      },
      commands: [
        {
          name: "close",
          description: "Close an idle session; keep running work monitored",
        },
        {
          name: "storage",
          description: "Preview session storage and explicitly clean snapshots",
        },
        { name: "search", description: "Search full messages in this session" },
        { name: "questions", description: "Answer or dismiss saved questions" },
        {
          name: "plan",
          description: "Read-only planning, questions and plan review",
        },
        {
          name: "tasks",
          description: "Manage pending messages, terminals and child agents",
        },
        {
          name: "changes",
          description: "Review file edits and safely roll them back",
        },
        ...runtime.resources.skills.map((skill) => ({
          name: "skill:" + skill.name,
          description: skill.description.slice(0, 120),
        })),
        ...[...runtime.plugins.commands.keys()].map((name) => ({
          name,
          description: "Plugin command",
        })),
      ],
      preparePrompt: (text, signal) =>
        text.startsWith("!")
          ? Promise.resolve({ text })
          : runtime.preparePrompt(session, text, signal),
      onPrompt: async (text, images, files) => {
        const queued = agent.busy;
        drafts.update(session.id, "");
        await drafts.flush();
        if (text.startsWith("!")) {
          await agent.executeTool("shell", parseManualCommand(text), text);
          return;
        }
        const { completion: work } = await agent.enqueuePrompt(
          text,
          images,
          undefined,
          files,
        );
        promptWork = work;
        const pending = agent.pendingPrompts().length;
        if (queued && pending)
          view.notice(
            `Message queued · ${pending} pending. Open Activity to manage.`,
          );
        try {
          await work;
        } finally {
          if (promptWork === work) promptWork = undefined;
        }
        if (!exiting && !disposed) await reviewCurrentPlan();
      },
      onExit: exit,
      onSelectSession: async (id) => {
        await workspace.open(id);
      },
      onStateChange: () => workspace?.refresh(),
      onSteer: async (text, expectedRunId) => {
        if (!expectedRunId)
          throw Error("No active run to intervene in; draft retained");
        const steeringId = await agent.steer(text, undefined, expectedRunId);
        drafts.update(session.id, "");
        await drafts.flush();
        return steeringId;
      },
      onCancelRun: (runId) => agent.cancelRun(runId),
      onHistory: history,
      onCommand: async (text) => {
        const [command, ...parts] = text.slice(1).split(" ");
        const arg = parts.join(" ");
        const reviewChanges = async (
          filter: import("../../../packages/runtime/src/change-review.ts").ReviewFilter = {},
        ) => {
          const { openChangeReview } =
            await import("../../../packages/tui/src/change-review.ts");
          let reviewRows: import("../../../packages/runtime/src/change-review.ts").ReviewEntry[] =
            [];
          let warnings: string[] = [];
          await openChangeReview(view, {
            cwd: session.cwd,
            list: async () => {
              const page = await runtime.review.list(session.id, filter);
              reviewRows = page.items;
              warnings = page.warnings;
              return reviewRows;
            },
            warnings: () => warnings,
            detail: (id) => {
              const row = reviewRows.find((row) => row.id === id);
              if (!row) throw Error("Change not found; refresh the list");
              return runtime.review.detail(session.id, row);
            },
            rollback: (id, signal) =>
              runtime.rollbackChange(session, id, signal),
            redo: (id, signal) => runtime.redoChange(session, id, signal),
          });
        };
        const applyActiveModel = async (
          settings: import("../../../packages/core/src/types.ts").ModelSettings,
        ) => {
          await bind(
            await runtime.setModel(
              session,
              agent.options.provider.id,
              agent.options.provider.model,
              settings,
            ),
          );
        };
        const configureSettings = async () => {
          const { openGeneralSettings } =
            await import("../../../packages/tui/src/general-settings.ts");
          await openGeneralSettings(view, preferences, applyPreferences);
        };
        const configureControl = async (
          field: "context" | "thinking" | "speed",
        ) => {
          if (agent.busy)
            throw Error(
              "Finish or cancel the run before changing model settings.",
            );
          const { openModelControl } =
            await import("../../../packages/tui/src/model-settings.ts");
          const active = agent.options.session.modelSelection!;
          const defaults =
            (await runtime.providerCatalog().readDefault()) ??
            runtime.defaultSelection();
          await openModelControl(
            view,
            runtime.providerCatalog(),
            field,
            active,
            defaults,
            applyActiveModel,
            (next) => runtime.saveDefaultSelection(next),
            arg,
          );
        };
        switch (command) {
          case "questions": {
            await localQuestions.open();
            return;
          }
          case "search": {
            const { openMessageSearch } =
              await import("../../../packages/tui/src/message-search.ts");
            const { libraryRequest } = await import("./rpc-library.ts");
            const id = session.id;
            await openMessageSearch(
              view,
              arg,
              (query, before) =>
                runtime.store.searchMessages(id, query, before),
              async (request) =>
                (await libraryRequest(
                  runtime,
                  "messages.content",
                  request,
                  () => runtime.session(id),
                )) as import("../../../packages/tui/src/message-search.ts").SearchContent,
            );
            return;
          }
          case "plan": {
            if (arg.trim() === "progress") {
              const id = session.id;
              const { browsePlanProgress } =
                await import("../../../packages/tui/src/planning.ts");
              await browsePlanProgress(
                view,
                async () => {
                  await runtime.planning.load(id, true);
                  return runtime.planProgress(id);
                },
                {
                  changes: (planId, step) => reviewChanges({ planId, step }),
                  tool: async (planId, tool, offset, limit) => {
                    if (!(await runtime.review.owners(id)).has(tool.sessionId))
                      throw Error("Task tree changed");
                    return runtime.store.planEvidenceContent(
                      tool.sessionId,
                      id,
                      planId,
                      tool.seq,
                      offset,
                      limit,
                    );
                  },
                },
              );
              return;
            }
            if (arg.trim() === "history") {
              const id = session.id;
              const { browsePlanHistory } =
                await import("../../../packages/tui/src/planning.ts");
              await browsePlanHistory(view, {
                list: async (before) => {
                  await runtime.planning.load(id, true);
                  return runtime.planning.history(id, before);
                },
                detail: (version) => runtime.planning.version(id, version),
              });
              return;
            }
            if (agent.busy)
              throw Error(
                "Finish or cancel the current run and queued messages before opening Plan mode",
              );
            await runtime.planning.load(session.id, true);
            if (arg.trim() === "cancel") {
              const { confirmLeavePlan } =
                await import("../../../packages/tui/src/planning.ts");
              await confirmLeavePlan(view, async () => {
                await runtime.setPlanning(session, false);
                updateStatus();
                view.notice("Plan cancelled; no execution started.");
              });
              return;
            }
            if (!runtime.planning.get(session.id).active)
              await runtime.setPlanning(session, true);
            updateStatus();
            view.notice(
              "Plan mode · read-only. Describe the task; use /plan to review, /plan cancel to leave.",
            );
            if (arg.trim()) await agent.prompt(arg);
            await reviewCurrentPlan();
            return;
          }
          case "tasks": {
            if (sessionTransitions)
              throw Error(
                "Session is changing; reopen the execution reader when it finishes.",
              );
            // Register before dynamic imports: a concurrent bind must invalidate
            // both an open panel and a reader that has not opened its panel yet.
            const reader = new AbortController();
            executionReaders.add(reader);
            try {
              const history = /^history(?:\s+(.+))?$/u.exec(arg.trim());
              if (history) {
                const { browseExecutionHistory } =
                  await import("../../../packages/tui/src/execution-history.ts");
                const id = session.id;
                await browseExecutionHistory(
                  view,
                  {
                    list: (cursor) => runtime.executionHistoryPage(id, cursor),
                    detail: (runId, snapshot) =>
                      runtime.executionHistoryDetail(id, runId, snapshot),
                  },
                  history[1],
                  reader.signal,
                );
                return;
              }
              const { openExecutionControl } =
                await import("../../../packages/tui/src/execution-control.ts");
              await openExecutionControl(
                view,
                {
                  agent,
                  runtime,
                  session: session.id,
                },
                reader.signal,
              );
              return;
            } finally {
              executionReaders.delete(reader);
            }
          }
          case "changes": {
            // run.end reaches the view before lease release and queue cleanup.
            if (
              agent.busy &&
              agent.snapshot().runStatus !== "running" &&
              promptWork
            )
              await promptWork;
            if (agent.busy)
              throw Error("Finish or cancel the run before reviewing changes.");
            await reviewChanges();
            return;
          }
          case "permissions": {
            if (agent.busy)
              throw Error(
                "Finish or cancel the run before changing permissions.",
              );
            const { openPermissions } =
              await import("../../../packages/tui/src/permissions.ts");
            const { permissionModeSchema, permissionOptions } =
              await import("../../../packages/runtime/src/permissions.ts");
            const apply = async (
              mode: import("../../../packages/runtime/src/permissions.ts").PermissionMode,
            ) => {
              await runtime.setPermissionMode(mode);
              updateStatus();
              for (const handle of workspace.values())
                handle.view.setPermissionLabel(
                  permissionOptions.find((option) => option.value === mode)!
                    .label +
                    (runtime.planning.get(handle.id).active
                      ? " · Plan read-only"
                      : ""),
                );
              view.notice(
                `Permissions: ${permissionOptions.find((option) => option.value === mode)!.label} · saved for this workspace.`,
              );
            };
            if (arg) await apply(permissionModeSchema.parse(arg));
            else await openPermissions(view, runtime.permissionMode, apply);
            return;
          }
          case "settings":
            if (agent.busy)
              throw Error("Finish or cancel the run before changing settings.");
            if (arg)
              throw Error(
                "Use /context [default], /thinking [default], or /speed [default] for model settings.",
              );
            await configureSettings();
            return;
          case "context":
          case "thinking":
          case "speed":
            await configureControl(command);
            return;
          case "storage": {
            const { storageCommand } =
              await import("../../../packages/tui/src/storage.ts");
            const id = session.id;
            return storageCommand(arg, {
              preview: () => runtime.previewCleanup(id),
              clean: (token) => runtime.cleanupStorage(id, token),
            });
          }
          case "resources": {
            const { resourceCommand } =
              await import("../../../packages/tui/src/resources.ts");
            const result = await resourceCommand(arg, {
              reload: () => runtime.reloadResources(),
              install: (request) => runtime.installResource(request),
            });
            return (
              result ??
              `Skills (${runtime.resources.skills.length}):\n${runtime.resources.skills.map((s) => s.name + " · " + s.path).join("\n")}\n\nInstructions:\n${runtime.resources.instructions.join("\n") || "None"}\n\n/resources reload · Refresh skills and instructions\n/resources install skill|plugin PATH --trusted · Register a local source in place; plugins require host restart`
            );
          }
          case "status":
            return `Model (active): ${agent.options.provider.id}/${agent.options.provider.model}\nContext budget: ${agent.options.provider.contextWindow}\nReasoning: ${agent.options.session.modelSelection?.settings.reasoning ?? "auto"}\nSpeed: ${agent.options.session.modelSelection?.settings.speed ?? "default"}\nPermissions: ${runtime.permissionMode}\nSession: ${session.id}\nWorkspace: ${session.cwd}\nSkills: ${runtime.resources.skills.length}\nInput/output: ${agent.usage.input}/${agent.usage.output}\nEstimated API cost: $${agent.usage.cost.toFixed(4)}\nBudget: $${agent.budget.maxCost}; ${agent.budget.modelCallsLeft} model calls remain. Current Agent lifetime only; recreating the Agent or restarting resets usage and limits.`;
          case "quit":
            exit();
            return;
          case "paste-image": {
            const target = session.id;
            const draft = view.editor.getExpandedText();
            const { saveClipboardImage } =
              await import("../../../packages/runtime/src/clipboard-image.ts");
            const { attachmentReference } =
              await import("../../../packages/runtime/src/attachments.ts");
            const path = await saveClipboardImage();
            if (exiting) return;
            if (
              session.id !== target ||
              view.editor.getExpandedText() !== draft
            )
              return `Input changed; clipboard image saved at ${path}. Use /attach PATH to add it when ready.`;
            view.editor.setText(attachmentReference(path) + " ");
            return "Clipboard image attached. Add your question and press Enter. The private temporary file is retained for draft recovery.";
          }
          case "attach": {
            if (!arg.trim())
              return 'Use /attach PATH, then add your question and send. You can also type @file or @"path with spaces" directly.';
            const { attachmentReference } =
              await import("../../../packages/runtime/src/attachments.ts");
            // Accept quoted or shell-escaped paths from terminal drag-and-drop.
            view.editor.setText(attachmentReference(arg) + " ");
            return "Attachment added. Add your question and press Enter.";
          }
          case "help":
            return '/plan [TASK] · Read-only exploration, questions and plan review\n/plan cancel · Leave without executing\n/plan history · Read saved plan versions\n/plan progress · Read reported step status of the approved plan\n/questions · Answer or dismiss saved questions\n/tasks · Manage queued messages, background terminals and child agents\n/tasks history [RUN_ID] · Read saved runs without pausing the queue\n/search [TEXT] · Search this session and read matching messages\n/changes · Review and roll back recorded file edits\n/new  /sessions  /resume [ID]  /rename TITLE  /export\n/fork  /compact  /model provider/model\n/attach PATH · @file or @"path with spaces" attaches text/images\n/settings  /permissions [ask|auto|full]\n/context [default]  /thinking [default]  /speed [default]\n/status  /resources  /storage\n/steer instructions  /tools  /older  /newer  /latest  /quit\n![--unrestricted] COMMAND follows the current permission mode. Ctrl+C cancels. Ctrl+D exits. Shift+Enter adds a line.\nEnter intervenes during a run. Ctrl+X Enter queues a separate task. Ctrl+P opens actions; Ctrl+O switches sessions. /model includes provider accounts.';
          case "close":
            await workspace.close(session.id);
            return;
          case "new":
            workspace.assertCapacity();
            await bind(await runtime.session());
            return;
          case "rename":
            if (!arg.trim()) throw Error("Use /rename TITLE");
            session = await runtime.renameSession(session.id, arg);
            return "Session renamed.";
          case "export":
            return `Exported: ${await runtime.exportSession(session.id, preferences.showThinking)}\nIf an .assets folder is present beside the Markdown, copy it together with the file.`;
          case "resume":
          case "sessions": {
            let replacementPrepared = false;
            const { sessionCommand } =
              await import("../../../packages/tui/src/sessions.ts");
            await sessionCommand(view, command, arg, {
              current: () => session.id,
              list: (offset, limit, query) =>
                runtime.store.sessions(
                  offset,
                  limit,
                  runtime.options.cwd,
                  query,
                ),
              flush: () => drafts.flush(),
              open: async (id) => bind(await runtime.session(id)),
              create: async () => {
                if (!replacementPrepared) await bind(await runtime.session());
              },
              remove: async (id) => {
                if (workspace.current?.id === id) {
                  const replacement = workspace
                    .values()
                    .find((handle) => handle.id !== id);
                  await workspace.open(
                    replacement?.id ?? (await runtime.session()).id,
                  );
                  replacementPrepared = true;
                }
                const result = await runtime.deleteSession(id);
                await workspace.forget(id);
                return result.cleanupError;
              },
              rename: async (id, title) => {
                const next = await runtime.renameSession(id, title);
                if (id === session.id) session = next;
              },
            });
            return;
          }
          case "compact":
            await bind(await runtime.compact(session));
            return;
          case "fork":
            await bind(await runtime.fork(session));
            return;
          case "steer":
            await agent.steer(arg);
            return "Instructions queued for the next model turn.";
          case "login":
          case "logout":
          case "model": {
            if (!arg || command !== "model") {
              const { openModelPicker } =
                await import("../../../packages/tui/src/model-picker.ts");
              await openModelPicker(
                view,
                runtime.providerCatalog(),
                async (provider, model, makeDefault) => {
                  const updated = await runtime.setModel(
                    session,
                    provider,
                    model,
                  );
                  await bind(updated);
                  if (makeDefault)
                    await runtime.saveDefaultSelection(updated.modelSelection!);
                },
                {
                  mode: command === "model" ? "models" : command,
                  ...(arg && command !== "model"
                    ? { provider: arg.trim() }
                    : {}),
                  current: session.modelSelection,
                  ownerLabel: "Local Keychain · Hikaro",
                  switchBlockedReason: () =>
                    agent.busy
                      ? "Finish or cancel this session's run before switching models."
                      : undefined,
                  credentialChangeBlockedReason: (provider) =>
                    workspace
                      .values()
                      .some(
                        (handle) =>
                          handle.provider?.() === provider &&
                          handle.view.isBusy,
                      )
                      ? "A monitored session is using this provider. Finish or cancel its run before changing credentials."
                      : undefined,
                  affectedSessions: (provider) =>
                    workspace
                      .values()
                      .filter((handle) => handle.provider?.() === provider)
                      .map((handle) => handle.title()),
                  onCredentialsChanged: () => {
                    runtime.reloadProviderCatalog();
                    for (const handle of workspace.values())
                      handle.view.refreshWorkspace("Context");
                  },
                },
                configureSettings,
              );
              return;
            }

            const slash = arg.indexOf("/");
            if (slash < 1) throw Error("Use /model provider/model");
            await bind(
              await runtime.setModel(
                session,
                arg.slice(0, slash),
                arg.slice(slash + 1),
              ),
            );
            return;
          }
          default:
            if (command?.startsWith("skill:")) {
              const skill = runtime.resources.skills.find(
                (skill) => skill.name === command.slice(6),
              );
              if (!skill)
                throw Error(
                  "Skill not found. Use /resources to list loaded skills.",
                );
              await agent.prompt(
                `Use the ${skill.name} skill. Read ${JSON.stringify(skill.path)} before working.\n\n${arg || "Apply the skill to the current task."}`,
              );
              return;
            }
            await runtime.planning.load(session.id, true);
            if (runtime.planning.get(session.id).active)
              throw Error(
                "Plugin commands and views are unavailable in read-only Plan mode",
              );
            if (command === "plugin-stop") {
              runtime.pluginRuns.cancel(session.id, arg.trim());
              return "Plugin cancellation requested; wait for execution to settle.";
            }
            if (
              runtime.plugins.commands.has(command!) ||
              runtime.plugins.views.has(command!)
            ) {
              return openPluginExecution(
                view,
                command!,
                (invocationId) =>
                  runtime.invokePlugin(
                    session,
                    command!,
                    runtime.plugins.commands.has(command!) ? "command" : "view",
                    arg,
                    { invocationId },
                  ),
                async (invocationId) =>
                  runtime.pluginRuns.cancel(session.id, invocationId),
              );
            }
            throw Error(`Unknown command: /${command}`);
        }
      },
    });
    removeStatus = agent.subscribe((event) => {
      if (event.type === "run.end") updateStatus();
    });
    updateStatus();
    const refreshGitStatus = () => {
      if (exiting || disposed || runtime.planning.get(session.id).active)
        return;
      void Promise.all([
        readGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
        readGit([
          "-c",
          "core.fsmonitor=false",
          "--no-optional-locks",
          "status",
          "--porcelain",
          "-uno",
        ]),
      ]).then(([branch, dirty]) => {
        if (exiting || disposed) return;
        gitBranch = branch + (dirty ? "*" : "");
        updateStatus();
      });
    };
    view.setActive(false);
    view.setPreferences(preferences);
    view.bind(agent);
    view.showMessages(
      historyPage.items.map((i) => i.message),
      historyPage,
    );
    view.editor.setText(await runtime.store.draft(session.id));
    for (const item of historyPage.items)
      if (item.message.role === "user")
        view.editor.addToHistory(item.message.text);
    setImmediate(refreshGitStatus);
    view.startTheme();
    void import("./workbench-sources.ts")
      .then(({ nativeWorkspaceSources }) => {
        if (!exiting && !disposed)
          view.setWorkspaceSources(
            nativeWorkspaceSources(
              view,
              runtime,
              () => session,
              () => agent,
            ),
          );
      })
      .catch((error) => {
        if (!exiting && !disposed) view.setError(String(error));
      });
    const removeWorkspaceEvents = agent.subscribe((event) => {
      if (
        event.type === "message" &&
        (event.data.message as { role?: string }).role === "user" &&
        session.title === "New session"
      )
        session.title = String(
          (event.data.message as { text?: string }).text ?? "",
        ).slice(0, 80);
      workspace.refresh(session.id);
    });
    return {
      id: session.id,
      view,
      title: () => session.title,
      provider: () => session.modelSelection?.provider,
      state: () =>
        view.attentionCount
          ? "Waiting for approval"
          : agent.snapshot().runStatus === "running"
            ? "Working"
            : agent.snapshot().runStatus === "failed"
              ? "Failed"
              : agent.snapshot().runStatus === "cancelled"
                ? "Stopped"
                : "Ready",
      canClose: () =>
        !agent.busy &&
        !view.attentionCount &&
        backgroundWorkSettled(
          runtime.terminals.list(session.id),
          runtime.childTasks(session.id),
        ),
      flush: async () => {
        drafts.update(draftSessionId, view.editor.getExpandedText());
        await drafts.flush();
      },
      close: async () => {
        disposed = true;
        removeWorkspaceEvents();
        removeStatus();
        for (const reader of executionReaders) reader.abort();
        view.dispose();
      },
    };
  }
  try {
    await workspace.open(initialSession.id);
    if (exiting) return;
    process.once("SIGTERM", exit);
    process.once("SIGHUP", exit);
    runtime.startJobs();
    tui.start();
    tui.requestRender(true);
  } catch (error) {
    if (!exiting) {
      await shutdown();
      throw error;
    }
  }
}
