import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { spawn as spawnPty, type IPty } from "node-pty";
import { stripVTControlCharacters } from "node:util";
import { serveSharedHost } from "../packages/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientFiles } from "../packages/host/src/client-files.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
const clock = {
  id: randomUUID,
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
async function directory() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-shared-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  return { home, cwd };
}
async function toolProvider(home: string) {
  await writeFile(
    join(home, "fixture.mjs"),
    `export default {id:"shared-fixture",apiVersion:1,setup(host){
    host.registerProvider("fixture",async()=>({id:"fixture",model:"host",contextWindow:32000,
      async *stream({messages,signal}){signal.throwIfAborted();const last=messages.at(-1);
        const message=last.role==="user"?{role:"assistant",text:"",timestamp:1,toolCalls:[last.text==="delegate"?{id:"delegate",name:"subagent",arguments:{task:"nested-proof"}}:{id:last.text,name:"write_file",arguments:{path:last.text+".txt",content:"approved"}}]}:{role:"assistant",text:"finished once",timestamp:1};
        yield {type:"done",message,usage:{input:0,output:0,cost:0}};
      }
    }));
  }};`,
  );
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: [{ path: "fixture.mjs", trusted: true }] }),
  );
}
async function startHost(options: { home: string; cwd: string }) {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    resolve("packages/cli/src/index.ts"),
    "--host",
    "--demo",
    "--home",
    options.home,
    "--cwd",
    options.cwd,
  ]);
  let output = "";
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Host startup timed out: " + output));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-8192);
      if (output.includes("shared host ready:")) {
        clearTimeout(timer);
        done();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Host exited " + code + ": " + output));
    });
  });
  return child;
}
async function stop(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
it("recovers a recreated view's durable intent, then fences a crashed host without replay", async () => {
  const options = await directory();
  let host = await startHost(options);
  let wire = await SharedHostClient.connect({
    ...options,
    clientId: "recover",
  });
  const files = await ClientFiles.open(
    wire.endpoint.home,
    wire.endpoint.key,
    wire.scope,
  );
  let client = new ClientConnection(
    wire.scope,
    {
      observe: (fn) =>
        wire.observe((frame) => {
          if (frame.type !== "response" || frame.result?.accepted !== true)
            fn(frame);
        }),
      send: (frame) => wire.send(frame),
    },
    { ...clock, intents: files },
  );
  let off = wire.onConnection((ready) => {
    if (!ready) client.disconnected();
  });
  try {
    await client.connected();
    const session = (await client.request("session.create")) as any;
    const pending = client.request("prompt", {
      text: "survive-disconnect " + "x".repeat(700),
    });
    const rejected = expect(pending).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(client.state.busy).toBe(true));
    const run = client.state.runId;
    expect(JSON.stringify(await files.load())).not.toContain(
      "survive-disconnect",
    );
    off();
    client.disconnected();
    await wire.close();
    await rejected;
    client.close();
    wire = await SharedHostClient.connect({ ...options, clientId: "recover" });
    client = new ClientConnection(wire.scope, wire, {
      ...clock,
      intents: files,
    });
    off = wire.onConnection((ready) => {
      if (ready) void client.connected().catch(() => {});
      else client.disconnected();
    });
    await client.connected();
    expect(client.state.session?.id).toBe(session.id);
    expect(client.state.runId).toBe(run);
    await vi.waitFor(() => expect(client.state.runStatus).toBe("completed"), {
      timeout: 5000,
    });
    // run.end is broadcast before the host persists the receipt as completed.
    await vi.waitFor(
      async () => {
        await client.reconcile();
        expect(client.receipts.find((r) => r.method === "prompt")?.status).toBe(
          "completed",
        );
      },
      { timeout: 5000 },
    );
    await client.request("prompt", { text: "crash " + "x".repeat(2000) });
    await vi.waitFor(() => expect(client.state.busy).toBe(true));
    const crashedRun = client.state.runId;
    await stop(host, "SIGKILL");
    await vi.waitFor(() => expect(client.state.connection).toBe("offline"));
    host = await startHost(options);
    await vi.waitFor(() => expect(client.state.canAct).toBe(true), {
      timeout: 8000,
    });
    expect(client.state).toMatchObject({
      session: { id: session.id },
      runId: crashedRun,
      runStatus: "unknown",
      busy: false,
      approvals: [],
    });
    const events = (await client.request("events.read", {
      limit: 1000,
    })) as any[];
    expect(events.filter((e) => e.type === "run.start")).toHaveLength(2);
    expect(
      client.receipts.filter((r) => r.method === "prompt").map((r) => r.status),
    ).toEqual(["completed", "unknown"]);
    // Insecure metadata fails closed without changing the running host.
    await chmod(wire.endpoint.metadata, 0o644);
    await expect(
      SharedHostClient.connect({ ...options, clientId: "unsafe" }),
    ).rejects.toThrow(/Unsafe/);
    await chmod(wire.endpoint.metadata, 0o600);
    // Reusing an identity fences its old view, rather than reconnecting forever.
    const replacement = await SharedHostClient.connect({
      ...options,
      clientId: "recover",
    });
    try {
      await vi.waitFor(() => expect(client.state.connection).toBe("offline"));
      await new Promise((done) => setTimeout(done, 300));
      expect((await replacement.request("session.current")).session.id).toBe(
        session.id,
      );
    } finally {
      await replacement.close();
    }
  } finally {
    off();
    client.close();
    await wire.close();
    await stop(host);
    await rm(options.home, { recursive: true, force: true });
  }
}, 20000);

it("attaches the real TUI, restores its draft and pending approval after exit, and accepts a second view's decision", async () => {
  const options = await directory();
  await toolProvider(options.home);
  const host = await serveSharedHost({
    ...options,
    provider: "fixture",
    model: "host",
  });
  const probe = await SharedHostClient.connect({
    ...options,
    clientId: "probe",
  });
  let terminal: IPty | undefined,
    exited: Promise<number> | undefined,
    output = "";
  const launch = () => {
    output = "";
    terminal = spawnPty(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("packages/cli/src/index.ts"),
        "--attach",
        "--home",
        options.home,
        "--cwd",
        options.cwd,
        "--client-id",
        "pty",
      ],
      { cols: 100, rows: 30, env: { ...process.env, TERM: "xterm-256color" } },
    );
    terminal.onData((chunk) => {
      output = (output + stripVTControlCharacters(chunk)).slice(-100000);
    });
    exited = new Promise((done) =>
      terminal!.onExit(({ exitCode }) => done(exitCode)),
    );
  };
  try {
    launch();
    await vi.waitFor(
      () => expect(output).toContain("Attached to shared host"),
      { timeout: 8000 },
    );
    const sessions = await probe.request("session.list");
    const session = sessions[0];
    await probe.request("session.resume", { sessionId: session.id });
    terminal!.write("pty-approval\r");
    await vi.waitFor(() => expect(output).toContain("Permission required"), {
      timeout: 8000,
    });
    // Quit while the panel is visible; detaching must not submit a denial.
    terminal!.write("\x04");
    expect(await exited).toBe(0);
    terminal = undefined;
    const pending = await probe.request("session.current");
    expect(pending.busy).toBe(true);
    expect(pending.approvals).toHaveLength(1);
    launch();
    await vi.waitFor(() => expect(output).toContain("Permission required"), {
      timeout: 8000,
    });
    await probe.request("approval.respond", {
      id: pending.approvals[0].id,
      allow: true,
    });
    await vi.waitFor(() => expect(output).toContain("finished once"), {
      timeout: 8000,
    });
    expect(await readFile(join(options.cwd, "pty-approval.txt"), "utf8")).toBe(
      "approved",
    );
    terminal!.write("unsent-恢复");
    await new Promise((done) => setTimeout(done, 400));
    terminal!.kill("SIGKILL");
    await exited;
    terminal = undefined;
    launch();
    await vi.waitFor(() => expect(output).toContain("unsent-恢复"), {
      timeout: 8000,
    });
    expect(
      (await probe.request("events.read")).filter(
        (event: any) => event.type === "run.start",
      ),
    ).toHaveLength(1);
    terminal!.write("\x15\x04");
    expect(await exited).toBe(0);
    terminal = undefined;
  } finally {
    if (terminal) {
      terminal.kill("SIGKILL");
      await exited;
    }
    await probe.close();
    await host.close();
    await rm(options.home, { recursive: true, force: true });
  }
}, 25000);
