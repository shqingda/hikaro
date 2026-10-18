import { spawn as processSpawn } from "node:child_process";
import { spawn } from "node-pty";
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
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
  const seed = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  const target = await seed.session();
  await seed.renameSession(target.id, "Target oldest");
  for (let i = 0; i < 52; i++) await seed.session();
  await seed.close();
  const host = processSpawn(process.execPath, [
    "--import",
    "tsx",
    resolve("apps/cli/src/index.ts"),
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
          resolve("apps/cli/src/index.ts"),
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
    await wait("Session opened: Renamed target", send("\r"));
    await probe.request("session.resume", { sessionId: target.id });
    expect((await probe.request("session.current")).session.title).toBe(
      "Renamed target",
    );
    await wait("Select model", send("/model\r"));
    await wait("Offline demo", send("demo/offline"));
    await wait("Active model: demo/offline", send("\r"));
    await wait("/context · active", send("/context\r"));
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
    await wait("Display preferences saved", send("\x1b[B".repeat(2) + "\r"));
    expect(await files.preferences()).toMatchObject({ showUsage: false });
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
    const reopened = output.length;
    launch();
    await wait("Attached to shared host", reopened);
    await wait("Sessions · page 1", send("/sessions Renamed target\r"));
    await wait("● Renamed target", reopened);
    await wait("Enter send", send("\x1b"));
    await wait("Settings · saved immediately", send("/settings\r"));
    await wait("Hide", reopened);
    expect(await files.preferences()).toMatchObject({ showUsage: false });
    await wait("Display preferences saved", send("\x1b[B".repeat(4) + "\r"));
    expect(await files.preferences()).toMatchObject({ resumeOnStart: false });
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
    await wait("Session opened: Renamed target", send("\r"));
    await wait("Sessions · page 1", send("/sessions Renamed target\r"));
    await wait("Delete “Renamed target”?", send("\x1b[3~"));
    await wait("Sessions · page 1", send("\x1b"));
    expect(
      await probe.request("session.list", { query: "Renamed target" }),
    ).toHaveLength(1);
    await wait("Delete “Renamed target”?", send("\x1b[3~"));
    await wait("No matching sessions", send("\r"));
    expect(
      await probe.request("session.list", { query: "Renamed target" }),
    ).toHaveLength(0);
    await wait("Enter send", send("\x1b"));
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
