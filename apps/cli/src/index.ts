#!/usr/bin/env node
import { parseManualCommand } from "../../../packages/tui/src/manual-command.ts";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
const cliArgs = process.argv.slice(2);
// Accept the separator forwarded by package-manager run commands.
if (cliArgs[0] === "--") cliArgs.shift();
const { values, positionals } = parseArgs({
  args: cliArgs,
  allowPositionals: true,
  options: {
    host: { type: "boolean" },
    attach: { type: "boolean" },
    "client-id": { type: "string" },
    serve: { type: "boolean" },
    pair: { type: "boolean" },
    relay: { type: "string" },
    revoke: { type: "string" },
    backend: { type: "string" },
    "pi-command": { type: "string" },
    help: { type: "boolean", short: "h" },
    demo: { type: "boolean" },
    rpc: { type: "boolean" },
    models: { type: "boolean" },
    trust: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    "endpoint-key-env": { type: "string" },
    cwd: { type: "string" },
    home: { type: "string" },
    session: { type: "string" },
    continue: { type: "boolean", short: "c" },
    new: { type: "boolean" },
    prompt: { type: "string", short: "p" },
  },
});
async function main() {
  if (values.help) {
    console.log(
      `hikaro — independent coding agent\n\nUsage: hikaro [--demo] [--provider anthropic --model MODEL]\n  --trust             Allow file edits inside this workspace\n  --prompt, -p TEXT   Run once and print the response\n  --host              Run a persistent shared task host\n  --attach            Attach this TUI to the shared host\n  --serve             Connect the shared host to the encrypted relay\n  --client-id ID      Stable attached TUI identity (default: main)\n  --rpc               JSONL protocol over stdin/stdout\n  --models            List provider/model identifiers\n  --session ID        Resume a saved session\n  --continue, -c      Resume last opened session (default in TUI)\n  --new               Start a new interactive session\n  --base-url URL      OpenAI-compatible endpoint\n  --endpoint-key-env NAME  Save this environment key for the exact --base-url\n  --cwd PATH          Workspace (defaults to current directory)\n  --home PATH         Data directory (defaults to ~/.hikaro)\n\nAPI keys use provider environment variables. Interactive /permissions controls workspace approval mode.\nUse --demo to try the UI without credentials.`,
    );
    return;
  }
  if (values.models) {
    const { listModels } =
      await import("../../../packages/provider-pi/src/index.ts");
    for (const m of await listModels())
      console.log(`${m.provider}/${m.id}\t${m.context}`);
    return;
  }
  const options = {
    cwd: values.cwd ?? process.cwd(),
    home: values.home ?? process.env.HIKARO_HOME,
    trusted: values.trust,
    demo: values.demo,
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
  };
  if (values["endpoint-key-env"]) {
    if (!options.baseUrl)
      throw Error("--endpoint-key-env requires an explicit --base-url");
    const apiKey = process.env[values["endpoint-key-env"]];
    if (!apiKey?.trim())
      throw Error("Endpoint API key environment variable is empty or unset");
    const { KeychainCredentials } =
      await import("../../../packages/provider-pi/src/credentials.ts");
    const { saveEndpointApiKey } =
      await import("../../../packages/provider-pi/src/endpoint.ts");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    await saveEndpointApiKey(
      new KeychainCredentials(options.home ?? join(homedir(), ".hikaro")),
      options.baseUrl,
      apiKey,
    );
  }
  if (values.pair) {
    const { pairDevice } = await import("../../../packages/remote/src/host.ts");
    const code = await pairDevice({
      home: options.home,
      relay: values.relay,
      bootstrap: process.env.HIKARO_RELAY_BOOTSTRAP,
    });
    if (process.stdout.isTTY) {
      const qr = await import("qrcode-terminal");
      qr.default.generate(code, { small: true });
    }
    console.log(code);
    return;
  }
  if (values.revoke) {
    const { revokeDevice } =
      await import("../../../packages/remote/src/host.ts");
    await revokeDevice(options.home, values.revoke);
    return;
  }
  if (
    (values.attach || values.serve) &&
    (values.demo ||
      values.provider ||
      values.model ||
      values["base-url"] ||
      values.trust)
  )
    throw Error(
      "Configure --demo, provider, model, endpoint and trust on --host; clients attach to its existing configuration",
    );
  if (values.host) {
    if (values.attach || values.serve || values.rpc || values.prompt)
      throw Error("--host runs independently of client modes");
    const { serveSharedHost } = await import("./shared-host.ts");
    const host = await serveSharedHost(options);
    console.error(`Hikaro shared host ready: ${host.endpoint.cwd}`);
    return;
  }
  if (values.attach) {
    if (values.serve || values.rpc || values.prompt)
      throw Error("Choose one client mode");
    const { attachTui } = await import("./attached-tui.ts");
    await attachTui({
      ...options,
      session: values.session,
      newSession: values.new,
      clientId: values["client-id"],
    });
    return;
  }
  if (values.serve) {
    const { serveRemote } =
      await import("../../../packages/remote/src/host.ts");
    await serveRemote(options);
    return;
  }
  if (values.rpc) {
    await (await import("./rpc.ts")).serveRpc(options);
    return;
  }
  if (values.backend === "pi") {
    const { PiBackend } =
      await import("../../../packages/pi-bridge/src/index.ts");
    const { createTerminal, HikaroView } =
      await import("../../../packages/tui/src/index.ts");
    if (!process.stdin.isTTY) throw Error("Pi bridge requires a terminal");
    const backend = await PiBackend.connect(
      values["pi-command"] ?? "pi",
      options.cwd,
    );
    const tui = createTerminal();
    let externalExiting = false;
    const leave = () => {
      if (externalExiting) return;
      externalExiting = true;
      view.dispose();
      tui.stop({ preserveScreen: true });
      void backend.close();
    };
    const view = new HikaroView(tui, {
      cwd: options.cwd,
      model: "external Pi",
      onPrompt: (text) => backend.prompt(text),
      onCommand: async (text) => {
        if (text === "/quit") {
          leave();
          return;
        }
        if (text.startsWith("/steer ")) {
          await backend.steer(text.slice(7));
          return;
        }
        if (text.startsWith("/permissions"))
          return "Pi owns tool permissions in this backend. Use the native Hikaro backend to change /permissions.";
        return "External Pi bridge: /steer text. Ctrl+D exits. Pi owns tools and permissions.";
      },
      onExit: leave,
    });
    view.bind(backend);
    view.setPermissionLabel("Managed by Pi");
    view.notice("Connected to Pi. Pi owns execution, tools, and permissions.");
    tui.setLayoutRoot(view.layout);
    tui.setFocus(view.editor);
    tui.start();
    process.once("SIGTERM", leave);
    process.once("SIGHUP", leave);
    return;
  }
  const { Runtime } = await import("../../../packages/runtime/src/index.ts");
  if (values.prompt) {
    const runtime = await Runtime.open({
      ...options,
      approve: async () => false,
    });
    try {
      const session = await runtime.session(values.session, values.continue);
      const agent = await runtime.agent(session);
      agent.subscribe((e) => {
        if (e.type === "text.delta") process.stdout.write(String(e.data.text));
        if (e.type === "tool.end" && (e.data.result as any)?.isError)
          process.stderr.write(`${(e.data.result as any).text}\n`);
      });
      const prepared = await runtime.preparePrompt(session, values.prompt);
      await agent.prompt(prepared.text, prepared.images);
      process.stdout.write("\n");
    } finally {
      await runtime.close();
    }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error(
      "Interactive mode requires a terminal. Use --prompt TEXT or --rpc.",
    );
  let view: import("../../../packages/tui/src/index.ts").HikaroView;
  let exiting = false;
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
  const { view: ui, runtime } = await openInteractive(
    import("../../../packages/tui/src/index.ts"),
    Runtime.open(
      {
        ...options,
        permissionMode,
        approve: (r, s) => view.approve(r, s),
        askUser: async (questions, signal) => {
          const { askQuestions } =
            await import("../../../packages/tui/src/planning.ts");
          return askQuestions(view, questions, signal);
        },
      },
      startupStore,
    ).catch(async (error) => {
      await startupStore.close();
      throw error;
    }),
  );
  const { createTerminal, HikaroView } = ui;
  const tui = createTerminal();
  const { loadTuiPreferences, saveTuiPreferences } =
    await import("../../../packages/tui/src/preferences.ts");
  let preferences = await loadTuiPreferences(runtime.options.home!);
  const { selectInitialSession } = await import("./startup.ts");
  let session: Awaited<ReturnType<typeof runtime.session>>;
  try {
    session = await selectInitialSession(
      runtime,
      {
        session: values.session,
        continue: values.continue,
        new: values.new,
        demo: values.demo,
        provider: values.provider,
        model: values.model,
        baseUrl: values["base-url"],
      },
      preferences,
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
  await runtime.store.rememberSession(session.id);
  let agent: Awaited<ReturnType<typeof runtime.agent>>;
  let promptWork: Promise<void> | undefined;
  try {
    agent = await runtime.agent(session);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const { DraftSaver } = await import("../../../packages/tui/src/drafts.ts");
  let draftSessionId = session.id;
  const drafts = new DraftSaver(
    (id, text) => runtime.store.saveDraft(id, text),
    (error) => view.setError(`Draft autosave failed: ${String(error)}`),
  );
  const exit = () => {
    if (exiting) return;
    exiting = true;
    view.dispose();
    tui.stop({ preserveScreen: true });
    console.log(`\nContinue: pnpm start · New session: pnpm start --new`);
    drafts.update(draftSessionId, view.editor.getExpandedText());
    void drafts
      .flush()
      .finally(() => runtime.close())
      .then(
        () => {
          process.exitCode = 0;
        },
        (e) => {
          console.error(e);
          process.exitCode = 1;
        },
      );
  };
  let historyPage = await runtime.store.messagePage(session.id, { limit: 20 });
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
    view.setInfo(
      `${options.cwd.replace(process.env.HOME ?? "", "~")}${gitBranch ? " (" + gitBranch + ")" : ""} · ↑${usage.input} ↓${usage.output} est $${usage.cost.toFixed(3)} · ${Math.round(agent.options.provider.contextWindow / 1000)}k · ${preferences.reasoning ?? "auto"}${preferences.speed && preferences.speed !== "default" ? " · " + preferences.speed : ""}`,
    );
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
      const { planText } =
        await import("../../../packages/runtime/src/planning.ts");
      view.notice(
        "Plan approved. Starting execution under the current permissions.",
      );
      await agent.prompt(
        `The user reviewed and approved plan ${approved.id}. Execute this plan and verify the result:\n${planText(approved)}`,
      );
      return;
    }
  };
  const bind = async (next: typeof session) => {
    if (agent.busy) throw Error("Cancel the active run first");
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
  };
  const applyPreferences = async (next: typeof preferences) => {
    preferences = await saveTuiPreferences(runtime.options.home!, next);
    view.setPreferences(preferences);
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
    cwd: options.cwd,
    model: `${agent.options.provider.id}/${agent.options.provider.model}`,
    onPreferences: (patch) => applyPreferences({ ...preferences, ...patch }),
    onDraftChange: (text) => drafts.update(draftSessionId, text),
    commands: [
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
    onPrompt: async (text, images) => {
      drafts.update(session.id, "");
      await drafts.flush();
      if (text.startsWith("!")) {
        await agent.executeTool("shell", parseManualCommand(text), text);
        return;
      }
      const { completion: work } = await agent.enqueuePrompt(text, images);
      promptWork = work;
      const pending = agent.pendingPrompts().length;
      if (pending)
        view.notice(
          `Message queued · ${pending} pending. Use /tasks to manage.`,
        );
      try {
        await work;
      } finally {
        if (promptWork === work) promptWork = undefined;
      }
      await reviewCurrentPlan();
    },
    onExit: exit,
    onHistory: history,
    onCommand: async (text) => {
      const [command, ...parts] = text.slice(1).split(" ");
      const arg = parts.join(" ");
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
        const tokens = arg.trim().split(/\s+/).filter(Boolean);
        const scope = tokens.includes("default") ? "default" : "active";
        const raw = tokens.filter((t) => t !== "active" && t !== "default");
        if (raw.length > 1)
          throw Error(`Use /${field} [VALUE] [active|default]`);
        const active = agent.options.session.modelSelection!;
        const defaults =
          (await runtime.providerCatalog().readDefault()) ??
          runtime.defaultSelection();
        if (raw.length) {
          const selected = scope === "active" ? active : defaults;
          let value: string | number | undefined = raw[0];
          if (value === "auto") value = undefined;
          else if (field === "context") {
            const match = /^(\d+)(k|m)?$/i.exec(value!);
            if (!match)
              throw Error(
                "Use /context auto, /context 128k, or /context 1000000",
              );
            value =
              Number(match[1]) *
              (match[2]?.toLowerCase() === "m"
                ? 1000000
                : match[2]?.toLowerCase() === "k"
                  ? 1000
                  : 1);
          }
          const key =
            field === "context"
              ? "contextWindow"
              : field === "thinking"
                ? "reasoning"
                : "speed";
          const settings = {
            ...selected.settings,
            [key]: value,
          } as typeof active.settings;
          if (scope === "active") await applyActiveModel(settings);
          else await runtime.saveDefaultSelection({ ...selected, settings });
          view.notice(
            `/${field}: ${scope === "active" ? "applied to this session" : "saved for new sessions"}.`,
          );
        } else
          await openModelControl(
            view,
            runtime.providerCatalog(),
            field,
            active,
            defaults,
            applyActiveModel,
            (next) => runtime.saveDefaultSelection(next),
            scope,
          );
      };
      switch (command) {
        case "plan": {
          if (agent.busy)
            throw Error(
              "Finish or cancel the current run and queued messages before opening Plan mode",
            );
          await runtime.planning.load(session.id, true);
          if (arg.trim() === "cancel") {
            const { panel, close } = view.openModelPanel();
            try {
              const result = await panel.choose(
                "Leave Plan mode?",
                [
                  { value: "keep", label: "Stay read-only" },
                  { value: "leave", label: "Leave without executing" },
                ],
                "Leaving allows future prompts to edit under the current permissions. No task starts now.",
                undefined,
                {
                  search: false,
                  requireNoticeVisible: true,
                  cancelValue: "keep",
                },
              );
              if (result.value === "leave") {
                await runtime.setPlanning(session, false);
                updateStatus();
                view.notice("Plan cancelled; no execution started.");
              }
            } finally {
              close();
            }
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
          const { openExecutionControl } =
            await import("../../../packages/tui/src/execution-control.ts");
          await openExecutionControl(view, {
            agent,
            runtime,
            session: session.id,
          });
          return;
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
          const { openChangeReview } =
            await import("../../../packages/tui/src/change-review.ts");
          await openChangeReview(view, {
            cwd: session.cwd,
            list: () => runtime.changes.list(session.id),
            detail: (id) => runtime.changes.detail(session.id, id),
            rollback: (id, signal) =>
              runtime.rollbackChange(session, id, signal),
          });
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
        case "resources":
          return `Skills (${runtime.resources.skills.length}):\n${runtime.resources.skills.map((s) => s.name + " · " + s.path).join("\n")}\n\nInstructions:\n${runtime.resources.instructions.join("\n") || "None"}`;
        case "status":
          return `Model (active): ${agent.options.provider.id}/${agent.options.provider.model}\nContext budget: ${agent.options.provider.contextWindow}\nReasoning: ${agent.options.session.modelSelection?.settings.reasoning ?? "auto"}\nSpeed: ${agent.options.session.modelSelection?.settings.speed ?? "default"}\nPermissions: ${runtime.permissionMode}\nSession: ${session.id}\nWorkspace: ${session.cwd}\nSkills: ${runtime.resources.skills.length}\nInput/output: ${agent.usage.input}/${agent.usage.output}\nEstimated API cost: $${agent.usage.cost.toFixed(4)}`;
        case "quit":
          exit();
          return;
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
          return '/plan [TASK] · Read-only exploration, questions and plan review\n/plan cancel · Leave without executing\n/tasks · Manage queued messages, background terminals and child agents\n/changes · Review and roll back recorded file edits\n/new  /sessions  /resume [ID]  /rename TITLE  /export\n/fork  /compact  /model provider/model\n/attach PATH · @file or @"path with spaces" attaches text/images\n/settings  /permissions [ask|auto|full]\n/context [default]  /thinking [default]  /speed [default]\n/status  /resources\n/steer instructions  /tools  /older  /newer  /latest  /quit\n![--unrestricted] COMMAND follows the current permission mode. Ctrl+C cancels. Ctrl+D exits. Shift+Enter adds a line.\nNew prompts queue while the agent works.';
        case "new":
          await bind(await runtime.session());
          return;
        case "rename":
          if (!arg.trim()) throw Error("Use /rename TITLE");
          session = await runtime.renameSession(session.id, arg);
          return "Session renamed.";
        case "export":
          return `Exported: ${await runtime.exportSession(session.id, preferences.showThinking)}`;
        case "resume":
          if (arg) {
            await bind(await runtime.session(arg));
            return;
          }
        case "sessions": {
          const { openSessions } =
            await import("../../../packages/tui/src/sessions.ts");
          await openSessions(
            view,
            () => session.id,
            (offset, limit, query) =>
              runtime.store.sessions(offset, limit, runtime.options.cwd, query),
            async (id) => {
              await bind(await runtime.session(id));
            },
            async (id) => {
              await drafts.flush();
              const result = await runtime.deleteSession(id);
              if (id === session.id) await bind(await runtime.session());
              return result.cleanupError;
            },
            async (id, title) => {
              const next = await runtime.renameSession(id, title);
              if (id === session.id) session = next;
            },
            command === "sessions" ? arg : "",
          );
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
        case "model": {
          if (!arg || command === "login") {
            if (agent.busy)
              throw Error(
                "Finish or cancel the active run before switching model.",
              );
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
              command === "login",
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
          if (runtime.plugins.commands.has(command!))
            return runtime.plugins.commands.get(command!)!(arg);
          if (runtime.plugins.views.has(command!))
            return runtime.plugins.views.get(command!)!();
          throw Error(`Unknown command: /${command}`);
      }
    },
  });
  removeStatus = agent.subscribe((event) => {
    if (event.type === "run.end") updateStatus();
  });
  updateStatus();
  const refreshGitStatus = () => {
    if (exiting || runtime.planning.get(session.id).active) return;
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
      if (exiting) return;
      gitBranch = branch + (dirty ? "*" : "");
      updateStatus();
    });
  };
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
  tui.setLayoutRoot(view.layout);
  tui.setFocus(view.editor);
  tui.start();
  // The editor, saved draft, history and permissions are ready. Paint them
  // immediately; advisory Git metadata can update after this first frame.
  tui.requestRender(true);
  setImmediate(refreshGitStatus);
  view.startTheme();
  runtime.startJobs();
  process.once("SIGTERM", exit);
  process.once("SIGHUP", exit);
}
main().catch((error) => {
  console.error(
    `hikaro: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
