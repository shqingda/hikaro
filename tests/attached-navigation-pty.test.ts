import { spawn as processSpawn } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientFiles } from "../packages/host/src/client-files.ts";
it("navigates sessions, model/defaults, settings, resources and login from the attached terminal", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hikaro-nav-pty-"))),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  await mkdir(join(cwd, ".agents/skills/navigation-proof"), {
    recursive: true,
  });
  await writeFile(
    join(cwd, ".agents/skills/navigation-proof/SKILL.md"),
    "---\nname: navigation-proof\ndescription: A resource inspection fixture\n---\nUse only when requested.",
  );
  await writeFile(
    join(home, "plugin.mjs"),
    `export default {id:'pty-proof',apiVersion:1,setup(api){api.registerCommand('pty-proof',async args=>'PLUGIN-COMMAND:'+args);api.registerView('pty-view',async()=>'PLUGIN-VIEW:ready');api.registerCommand('pty-wait',async (_,ctx)=>new Promise(resolve=>ctx.signal.addEventListener('abort',()=>resolve('late-result'),{once:true})))}}`,
  );
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: [{ path: "plugin.mjs", trusted: true }] }),
  );
  const seed = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  const target = await seed.session();
  await seed.renameSession(target.id, "Target oldest");
  const artifactFolder = join(home, "artifacts", target.id);
  const outputFolder = join(home, "outputs", target.id);
  await mkdir(artifactFolder, { recursive: true });
  await mkdir(outputFolder, { recursive: true });
  const logPath = join(
    outputFolder,
    "11111111-1111-4111-8111-111111111111.log",
  );
  await writeFile(logPath, "PORTABLE-TOOL-LOG 中文\n");
  const resultPath = join(artifactFolder, "a".repeat(64) + ".json");
  await writeFile(
    resultPath,
    JSON.stringify({
      text: "Portable visible tool result",
      providerData: "PRIVATE-TOOL-FIELD",
      data: { artifact: logPath },
    }),
  );
  await seed.store.append(target.id, "tool.end", {
    callId: "portable-artifact-fixture",
    name: "artifact_fixture",
    result: { text: "Result preview", data: { artifact: resultPath } },
  });
  for (let i = 0; i < 52; i++) await seed.session();
  await seed.close();
  const host = processSpawn(process.execPath, [
    "--import",
    "tsx",
    resolve("packages/cli/src/index.ts"),
    "--host",
    "--demo",
    "--home",
    home,
    "--cwd",
    cwd,
  ]);
  let hostOutput = "";
  host.stdout.on("data", (d) => {
    hostOutput += d;
  });
  host.stderr.on("data", (d) => {
    hostOutput += d;
  });
  const hostExit = new Promise<void>((done) => host.on("exit", () => done()));
  let term: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number> | undefined;
  let probe: SharedHostClient | undefined;
  try {
    await vi.waitFor(() => expect(hostOutput).toContain("shared host ready"), {
      timeout: 8000,
    });
    probe = await SharedHostClient.connect({ home, cwd, clientId: "probe" });
    await probe.request("hello");
    const files = await ClientFiles.open(
      probe.endpoint.home,
      probe.endpoint.key,
      "local:navigation",
    );
    let output = "";
    const watchers = new Set<() => void>();
    const launch = () => {
      term = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("packages/cli/src/index.ts"),
          "--attach",
          "--client-id",
          "navigation",
          "--home",
          home,
          "--cwd",
          cwd,
        ],
        {
          cwd: process.cwd(),
          cols: 110,
          rows: 38,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      exited = new Promise<number>((done) =>
        term!.onExit(({ exitCode }) => done(exitCode)),
      );
      term.onData((d) => {
        output += d;
        for (const fn of watchers) fn();
      });
    };
    const send = (text: string) => {
      const offset = output.length;
      term!.write(text);
      return offset;
    };
    const wait = (text: string, offset = 0) =>
      new Promise<void>((done, reject) => {
        const check = () => {
          if (stripVTControlCharacters(output.slice(offset)).includes(text)) {
            clearTimeout(timer);
            watchers.delete(check);
            done();
          }
        };
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(
            Error(
              `Missing ${text}: ${stripVTControlCharacters(output.slice(-7000))}`,
            ),
          );
        }, 8000);
        watchers.add(check);
        check();
      });
    launch();
    await wait("Attached to shared host");
    await wait("Sessions · page 1", send("/sessions Target\r"));
    await wait("Rename session", send("\x12"));
    await wait("Sessions · page 1", send("\x01\x0bRenamed target\r"));
    const resumed = send("\r");
    await wait("Renamed target", resumed);
    await wait("Enter send", resumed);
    await vi.waitFor(async () => {
      expect(await files.workspace()).toMatchObject({ selected: target.id });
    });
    const workspaceState = (await files.workspace()) as {
      sessions: Array<{ id: string; clientId: string }>;
      selected: string;
    };
    expect(workspaceState.selected).toBe(target.id);
    const selectedClient = workspaceState.sessions.find(
      (session) => session.id === target.id,
    )!;
    const selectedFiles = await ClientFiles.open(
      probe.endpoint.home,
      probe.endpoint.key,
      `local:${selectedClient.clientId}`,
    );
    await probe.request("session.resume", { sessionId: target.id });
    expect((await probe.request("session.current")).session.title).toBe(
      "Renamed target",
    );
    await wait("Running pty-wait", send("/pty-wait\r"));
    await wait("Plugin cancelled", send("\x03"));
    await wait("PLUGIN-COMMAND:direct", send("/pty-proof direct\r"));
    await wait("Host plugins", send("/plugins\r"));
    await wait("pty-view", send("pty-view"));
    await wait("Run pty-view?", send("\r"));
    await wait("Plugin result · pty-view", send("\x1b[B\r"));
    await wait("PLUGIN-VIEW:ready");
    await wait("Host plugins", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    await wait(
      "Permission required",
      send("! --unrestricted printf manual-ui-proof\r"),
    );
    await wait("Manual command finished", send("\x1b[A\r"));
    await wait(
      "Permission required",
      send("! --unrestricted touch rejected-ui-proof\r"),
    );
    await wait("Manual command failed", send("\x1b"));
    await expect(readFile(join(cwd, "rejected-ui-proof"))).rejects.toThrow();
    await wait("Permission required", send("! --unrestricted sleep 30\r"));
    const running = send("\x1b[A\r");
    await vi.waitFor(async () =>
      expect((await probe!.request("session.current")).busy).toBe(true),
    );
    send("\x03");
    await vi.waitFor(
      async () =>
        expect((await probe!.request("session.current")).busy).toBe(false),
      { timeout: 8000 },
    );
    await wait("Enter send", running);
    await wait("Exported:", send("/export\r"));
    const exported = (await readdir(join(home, "exports"))).find((name) =>
      name.endsWith(".md"),
    )!;
    const document = await readFile(join(home, "exports", exported), "utf8");
    expect(document).toContain("manual-ui-proof");
    expect(document).toContain("PLUGIN-COMMAND:direct");
    expect(document).toContain("PLUGIN-VIEW:ready");
    expect(document).toContain("Saved tool artifacts");
    const logReference = document.match(/\[tool-\d+\.log\]\(([^)]+)\)/)?.[1];
    expect(logReference).toBeTruthy();
    expect(logReference!.startsWith("/")).toBe(false);
    expect(await readFile(join(home, "exports", logReference!), "utf8")).toBe(
      "PORTABLE-TOOL-LOG 中文\n",
    );
    const jsonReference = document.match(/\[tool-\d+\.json\]\(([^)]+)\)/)?.[1];
    expect(
      JSON.parse(await readFile(join(home, "exports", jsonReference!), "utf8")),
    ).toEqual({ text: "Portable visible tool result" });
    expect(document).not.toContain("PRIVATE-TOOL-FIELD");
    await wait("Recovery · operation receipts", send("/recovery\r"));
    await wait("plugins.invoke · completed", send("plugins.invoke"));
    await wait("Operation outcome", send("\r"));
    await wait("Original session opened", send("\x1b[B\r"));
    await wait("Select model", send("/model\r"));
    await wait("Offline demo", send("demo/offline"));
    await wait("Active model: demo/offline", send("\r"));
    await wait("/context · active", send("/context active\r"));
    await wait("applied to this session", send("\x1b[B\r"));
    expect(
      (await probe.request("model.read")).current.settings.contextWindow,
    ).toBe(16000);
    await wait("/context · default", send("/context default\r"));
    await wait("default saved", send("\x1b[B".repeat(2) + "\r"));
    const model = await probe.request("model.read");
    expect(model.current.settings.contextWindow).toBe(16000);
    expect(model.default.settings.contextWindow).toBe(32000);
    await wait("/thinking · active", send("/thinking\r"));
    await wait("applied to this session", send("\x1b[B\r"));
    await wait("/speed · active", send("/speed\r"));
    await wait("applied to this session", send("\r"));
    await wait("Permissions · this workspace", send("/permissions\r"));
    await wait("Host workspace permissions saved: auto", send("\x1b[B\r"));
    expect(await probe.request("workspace.current")).toMatchObject({
      permissionMode: "auto",
    });
    await wait("Settings · saved immediately", send("/settings\r"));
    await wait("Usage footer  Hide", send("\x1b[B".repeat(2) + "\r"));
    expect(await files.preferences()).toMatchObject({
      showUsage: false,
    });
    await wait("Enter send", send("\x1b"));
    await wait(
      "Host resources · search loaded entries",
      send("/resources navigation-proof\r"),
    );
    await wait("A resource inspection fixture", send("\r"));
    await wait("Host resources · search loaded entries", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    await wait("Select provider to configure", send("/login\r"));
    await wait("opencode-go", send("opencode-go"));
    await wait("Select authentication method", send("\r"));
    await wait("API key", send("\r"));
    send("never-display-this-secret");
    await wait("Enter send", send("\x1b"));
    expect(stripVTControlCharacters(output)).not.toContain(
      "never-display-this-secret",
    );
    send("\x04");
    expect(await exited).toBe(0);
    term = undefined;
    await selectedFiles.save([
      { id: "unresolved-ui-proof", method: "tool.manual" },
    ]);
    const reopened = output.length;
    launch();
    await wait("Attached to shared host", reopened);
    await wait("Recovery · operation receipts", send("/recovery\r"));
    await wait("tool.manual · unknown", reopened);
    await wait("No durable receipt found", send("\r"));
    await wait("Recovery · operation receipts", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    expect(await selectedFiles.load()).toContainEqual({
      id: "unresolved-ui-proof",
      method: "tool.manual",
    });
    await wait("Sessions · page 1", send("/sessions Renamed target\r"));
    await wait("● Renamed target", reopened);
    await wait("Enter send", send("\x1b"));
    await wait("Settings · saved immediately", send("/settings\r"));
    await wait("Hide", reopened);
    expect(await files.preferences()).toMatchObject({
      showUsage: false,
    });
    await wait("Startup  New session", send("\x1b[B".repeat(4) + "\r"));
    expect(await files.preferences()).toMatchObject({
      resumeOnStart: false,
    });
    await wait("Enter send", send("\x1b"));
    const before = (await probe.request("session.list", { limit: 100 })).length;
    send("\x04");
    expect(await exited).toBe(0);
    term = undefined;
    const fresh = output.length;
    launch();
    await wait("Attached to shared host", fresh);
    expect((await probe.request("session.list", { limit: 100 })).length).toBe(
      before + 1,
    );
    await wait("Sessions · page 1", send("/sessions Renamed target\r"));
    const selectedAgain = send("\r");
    await wait("Renamed target", selectedAgain);
    await wait("Enter send", selectedAgain);
    await wait("Sessions · page 1", send("/sessions Renamed target\r"));
    await wait("Delete “Renamed target”?", send("\x1b[3~"));
    await wait("Sessions · page 1", send("\x1b"));
    expect(
      await probe.request("session.list", { query: "Renamed target" }),
    ).toHaveLength(1);
    await wait("Delete “Renamed target”?", send("\x1b[3~"));
    await wait("Enter send", send("\r"));
    await vi.waitFor(async () => {
      expect(
        await probe!.request("session.list", { query: "Renamed target" }),
      ).toHaveLength(0);
    });
    send("\x04");
    expect(await exited).toBe(0);
    term = undefined;
  } finally {
    term?.kill();
    if (exited) await exited;
    await probe?.close();
    host.kill("SIGTERM");
    await hostExit;
    await rm(home, { recursive: true, force: true });
  }
}, 45000);
