#!/usr/bin/env node
import { parseArgs } from "node:util";
const cliArgs = process.argv.slice(2);
// Accept the separator forwarded by package-manager run commands.
if (cliArgs[0] === "--") cliArgs.shift();
if (cliArgs[0] === "update") {
  const { selfUpdate } = await import("./self-update.ts");
  try {
    await selfUpdate();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const { values } = parseArgs({
  args: cliArgs,
  allowPositionals: true,
  options: {
    host: { type: "boolean" },
    attach: { type: "boolean" },
    "client-id": { type: "string" },
    backend: { type: "string" },
    "pi-command": { type: "string" },
    "install-pi": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    demo: { type: "boolean" },
    rpc: { type: "boolean" },
    models: { type: "boolean" },
    trust: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    "endpoint-key-env": { type: "string" },
    "endpoint-capabilities": { type: "string" },
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
      `hikaro — independent coding agent\n\nUsage: hikaro [--demo] [--provider anthropic --model MODEL]\n       hikaro update | --version   (hk is the same command)\n  --trust             Allow file edits inside this workspace\n  --prompt, -p TEXT   Run once and print the response\n  --host              Run a persistent shared task host\n  --attach            Attach this TUI to the shared host\n  --client-id ID      Stable attached TUI identity (default: main)\n  --rpc               JSONL protocol over stdin/stdout\n  --install-pi        Install/update the persistent Pi entry for this home\n  --pi-command PATH   Pi executable for install or --backend pi\n  --models            List provider/model identifiers\n  --session ID        Resume a saved session\n  --continue, -c      Resume last opened session (default in TUI)\n  --new               Start a new interactive session\n  --base-url URL      OpenAI-compatible endpoint\n  --endpoint-key-env NAME  Save this environment key for the exact --base-url\n  --endpoint-capabilities JSON  Declare contextWindow, maxOutputTokens, images, reasoning\n  --cwd PATH          Workspace (defaults to current directory)\n  --home PATH         Data directory (defaults to ~/.hikaro)\n\nAPI keys use provider environment variables. Interactive /permissions controls workspace approval mode.\nUse --demo to try the UI without credentials.`,
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
  if (values["install-pi"]) {
    const { installPi } =
      await import("../../../packages/pi-bridge/src/install.ts");
    const installed = await installPi({
      command: values["pi-command"],
      home: values.home ?? process.env.HIKARO_HOME,
      cwd: values.cwd ?? process.cwd(),
    });
    console.log(
      `Hikaro installed in Pi; default entry enabled for ${installed.home}. Run pi, or pi --pi-native to stay in Pi.`,
    );
    return;
  }
  let endpointCapabilities:
    | import("../../../packages/core/src/types.ts").EndpointCapabilities
    | undefined;
  if (values["endpoint-capabilities"] !== undefined) {
    if (!values["base-url"])
      throw Error("--endpoint-capabilities requires an explicit --base-url");
    const { endpointCapabilitiesSchema } =
      await import("../../../packages/provider-pi/src/settings.ts");
    endpointCapabilities = endpointCapabilitiesSchema.parse(
      JSON.parse(values["endpoint-capabilities"]),
    );
  }
  const options = {
    cwd: values.cwd ?? process.cwd(),
    home: values.home ?? process.env.HIKARO_HOME,
    trusted: values.trust,
    demo: values.demo,
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
    endpointCapabilities,
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
  if (
    values.attach &&
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
    if (values.attach || values.rpc || values.prompt)
      throw Error("--host runs independently of client modes");
    const { serveSharedHost } = await import("./shared-host.ts");
    const host = await serveSharedHost(options);
    console.error(`Hikaro shared host ready: ${host.endpoint.cwd}`);
    return;
  }
  if (values.attach) {
    if (values.rpc || values.prompt) throw Error("Choose one client mode");
    const { attachTui } = await import("./attached-tui.ts");
    await attachTui({
      ...options,
      session: values.session,
      newSession: values.new,
      clientId: values["client-id"],
    });
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
    let removeBackendExit: (() => void) | undefined;
    const leave = () => {
      if (externalExiting) return;
      externalExiting = true;
      removeBackendExit?.();
      view.dispose();
      tui.stop({ preserveScreen: true });
      void backend.close();
    };
    const view = new HikaroView(tui, {
      cwd: options.cwd,
      model: backend.currentModel
        ? `${backend.currentModel.provider}/${backend.currentModel.id}`
        : "external Pi · model unknown",
      availableActions: [
        "model",
        "queue",
        "stop",
        "inspect",
        "latest",
        "older",
      ],
      onPrompt: (text) => backend.prompt(text),
      onCommand: async (text) => {
        const [command, ...args] = text.trim().split(/\s+/);
        const arg = args.join(" ");
        if (["/model", "/login", "/logout"].includes(command!)) {
          const select = async (provider: string, model: string) => {
            const choice = await backend.setModel(provider, model);
            view.setModel(`${choice.provider}/${choice.id}`);
            view.refreshWorkspace("Context");
          };
          if (command === "/model" && arg) {
            const slash = arg.indexOf("/");
            if (slash < 1) throw Error("Use /model provider/model");
            await select(arg.slice(0, slash), arg.slice(slash + 1));
            return;
          }
          const [{ openModelPicker }, { piModelCatalog }] = await Promise.all([
            import("../../tui/src/model-picker.ts"),
            import("./pi-model-catalog.ts"),
          ]);
          await openModelPicker(view, piModelCatalog(backend), select, {
            mode: command === "/model" ? "models" : "providers",
            ownerLabel: "Managed by Pi",
            current: backend.currentModel
              ? {
                  provider: backend.currentModel.provider,
                  model: backend.currentModel.id,
                }
              : undefined,
            saveDefault: false,
            switchBlockedReason: () =>
              backend.isBusy
                ? "Finish or cancel the Pi task before switching models."
                : undefined,
            credentialChangeBlockedReason: () =>
              "Managed by Pi. Configure provider accounts in Pi.",
          });
          return;
        }
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
    view.setWorkspaceSources({
      Context: {
        title: "Pi context",
        description:
          "Execution, sessions, permissions and credentials are managed by Pi.",
        load: async () => [
          {
            id: "model",
            title: backend.currentModel?.name ?? "Model unknown",
            description: "Managed by Pi",
          },
        ],
        detail: async () => ({
          title: "Active Pi model",
          text: backend.currentModel
            ? `${backend.currentModel.provider}/${backend.currentModel.id}\nManaged by Pi`
            : "Pi did not report an active model.",
          actions: [
            {
              id: "model",
              title: "Browse Pi models",
              run: async () => {
                await view.command("/model");
              },
            },
          ],
        }),
      },
    });
    removeBackendExit = backend.client.onExit(() =>
      view.setStatus({ connection: "disconnected" }),
    );
    view.setPermissionLabel("Managed by Pi");
    view.notice("Connected to Pi. Pi owns execution, tools, and permissions.");
    tui.setLayoutRoot(view.layout);
    tui.setFocus(view.editor);
    tui.start();
    view.startTheme();
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
      await agent.prompt(
        prepared.text,
        prepared.images,
        undefined,
        prepared.files,
      );
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
  const { nativeTui } = await import("./native-tui.ts");
  await nativeTui(options, values, endpointCapabilities);
}
main().catch((error) => {
  console.error(
    `hikaro: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
