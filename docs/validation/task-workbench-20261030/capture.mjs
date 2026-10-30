// Actual production programs in a PTY; distinct from component fixtures.
// Run only after the final pnpm build: node docs/validation/task-workbench-20261030/capture.mjs
import { spawn } from "node-pty";
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
const root = resolve(import.meta.dirname, "../../..");
const directory = join(import.meta.dirname, "pty");
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "hikaro-workbench-capture-"));
const entry = join(root, "dist/hikaro.mjs");
const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const sizes = [
  [144, 40],
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
];
const env = {
  ...process.env,
  TERM: "xterm-256color",
  HIKARO_DEMO: "1",
  PI_CODING_AGENT_DIR: join(temporary, "pi"),
};
delete env.HIKARO_HOME;
delete env.NO_COLOR;
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source =
  'export async function authenticate(token: string) {\n  if (!token) throw new Error("Missing token");\n  return { authenticated: true };\n}\n';
const draft = "Review timeout handling 中文 @auth.ts ";
try {
  for (const mode of ["native", "attached", "external-pi", "embedded-pi"]) {
    for (const [columns, rows] of mode.includes("pi") ? [[120, 40]] : sizes) {
      const home = join(temporary, `${mode}-${columns}x${rows}`),
        cwd = join(home, "workspace");
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, "auth.ts"), source);
      let host, hostDone;
      let command = process.execPath,
        args = [entry, "--home", home, "--cwd", cwd];
      if (mode === "native") args.push("--demo");
      if (mode === "attached") {
        host = spawnProcess(process.execPath, [...args, "--demo", "--host"], {
          env,
        });
        hostDone = new Promise((resolve) => host.once("exit", resolve));
        await new Promise((resolve, reject) => {
          let text = "";
          const timer = setTimeout(
            () => reject(Error("Host startup timeout")),
            10000,
          );
          for (const stream of [host.stdout, host.stderr])
            stream.on("data", (data) => {
              text += data;
              if (text.includes("shared host ready")) {
                clearTimeout(timer);
                resolve();
              }
            });
          host.once("error", reject);
          host.once("exit", (code) => {
            clearTimeout(timer);
            reject(Error(`Host exited ${code}: ${text}`));
          });
        });
        args.push("--attach", "--client-id", "visual");
      }
      if (mode === "external-pi") {
        const wrapper = join(home, "offline-pi");
        await writeFile(
          wrapper,
          `#!/bin/sh\nexec '${pi.replaceAll("'", "'\\''")}' --offline --no-mcp --no-skills --no-context-files "$@"\n`,
          { mode: 0o700 },
        );
        args.push("--backend", "pi", "--pi-command", wrapper);
      }
      if (mode === "embedded-pi") {
        execFileSync(
          process.execPath,
          [entry, "--install-pi", "--pi-command", pi, "--home", home],
          { cwd, env, timeout: 30000 },
        );
        command = pi;
        args = [
          "--offline",
          "--no-session",
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
        ];
      }
      const terminal = spawn(command, args, { cwd, env, cols: columns, rows });
      let output = "",
        plain = "",
        exited = false;
      terminal.onData((data) => {
        output += data;
        plain += stripVTControlCharacters(data);
      });
      const done = new Promise((resolve) =>
        terminal.onExit(() => {
          exited = true;
          resolve();
        }),
      );
      const send = (text) => {
        const offset = plain.length;
        terminal.write(text);
        return offset;
      };
      const wait = async (pattern, offset = 0) => {
        const start = Date.now();
        while (!plain.slice(offset).includes(pattern)) {
          if (exited || Date.now() - start > 15000)
            throw Error(
              `${mode} ${columns}x${rows}: missing ${pattern}: ${plain.slice(-1800)}`,
            );
          await delay(20);
        }
      };
      const capture = async (scenario, suffix = scenario) => {
        await delay(180);
        const name = `${mode}-${columns}x${rows}${suffix ? `-${suffix}` : ""}`;
        await writeFile(join(directory, `${name}.ansi`), output);
        results.push({
          name,
          mode,
          scenario,
          columns,
          rows,
          program: mode.includes("pi")
            ? "Installed Pi 1.4.0 and production Hikaro"
            : "Production Hikaro",
          input:
            mode === "external-pi"
              ? "/model"
              : scenario === "conversation"
                ? "Review login timeout handling"
                : draft,
          inputMethod: "PTY keyboard/text injection; not native IME",
          draftSubmitted: false,
          capturedAt: new Date().toISOString(),
        });
        await writeFile(
          join(directory, "records.json"),
          JSON.stringify(results, null, 2) + "\n",
        );
      };
      try {
        await wait(
          mode === "embedded-pi"
            ? "Ready · Permissions: Hikaro"
            : mode === "external-pi"
              ? "Managed by Pi"
              : "Enter send",
        );
        if (mode === "external-pi") {
          await wait("Models", send("/model\r"));
          await capture("model", "");
        } else {
          await wait(
            "offline demo mode",
            send("Review login timeout handling\r"),
          );
          await delay(350); // The deterministic demo streams its remaining reply before run.end.
          if (columns === 120) await capture("conversation", "");
          if (!mode.includes("pi")) {
            await wait("Enter send");
            // This draft is never submitted. Context is opened via the real Actions palette.
            await wait("auth.ts", send(draft));
            await capture("draft");
            await wait("Actions", send("\x10"));
            await wait("Open Context", send("Open Context"));
            await wait("Draft and attachments", send("\r"));
            await wait("Draft attachment", send("/auth.ts\r"));
            await wait("Remove attachment", send("\r"));
            // Let the real local/host file preview finish, rather than capture its loading state.
            await delay(250);
            await capture("context");
            // Return through Actions, keeping the original unsent draft and editor focus.
            await wait("Actions", send("\x10"));
            await wait("Open Conversation", send("Open Conversation"));
            await wait("Enter send", send("\r"));
            await delay(80);
            if (!plain.slice(-5000).includes("auth.ts"))
              throw Error(`${mode}: draft was lost after Context`);
          }
        }
      } finally {
        terminal.kill("SIGTERM");
        await done;
        if (host) {
          host.kill("SIGTERM");
          await hostDone;
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      captures: results.length,
      records: join(directory, "records.json"),
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
