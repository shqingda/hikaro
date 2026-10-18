import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { ProcessClient } from "../packages/protocol/src/client.ts";
import { JsonLines } from "../packages/protocol/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { Runtime } from "../packages/runtime/src/index.ts";
import { serveRpc } from "../apps/cli/src/rpc.ts";
import type { AgentEvent } from "../packages/core/src/index.ts";

it("reconciles durable RPC outcomes after restart without replaying or crossing scopes", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-rpc-receipts-"));
  const start = () =>
    new ProcessClient(process.execPath, [
      "--import",
      "tsx",
      resolve("apps/cli/src/index.ts"),
      "--rpc",
      "--demo",
      "--home",
      home,
    ]);
  let client = start();
  const scope = "desktop";
  const request = (
    method: string,
    params: Record<string, unknown> = {},
    id?: string,
  ) => client.request(method, params, false, { scope, id });
  try {
    const hello = await request("hello");
    const session = await request("session.create", {}, "create-stable");
    await request("prompt", { text: "hello", images: [] }, "prompt-stable");
    await vi.waitFor(
      async () => {
        const { receipt } = await request("command.receipt", {
          commandId: "prompt-stable",
        });
        expect(receipt.status).toBe("completed");
        expect(receipt.runId).toBeTruthy();
      },
      { timeout: 5000 },
    );
    // JSON object key order is not a payload change.
    expect(
      await request("prompt", { images: [], text: "hello" }, "prompt-stable"),
    ).toMatchObject({ duplicate: true, receipt: { status: "completed" } });
    await expect(
      request("prompt", { text: "different" }, "prompt-stable"),
    ).rejects.toThrow(/conflict/i);
    expect(
      (
        await client.request(
          "command.receipt",
          { commandId: "prompt-stable" },
          false,
          { scope: "phone" },
        )
      ).receipt,
    ).toBeNull();
    await client.close();

    const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
    await store.acceptCommand({
      workspace: process.cwd(),
      scope,
      id: "interrupted",
      method: "prompt",
      digest: "f".repeat(64),
      hostInstanceId: hello.hostInstanceId,
      sessionId: session.id,
    });
    await store.close();
    client = start();
    const nextHello = await request("hello");
    expect(nextHello.hostInstanceId).not.toBe(hello.hostInstanceId);
    expect(
      (await request("command.receipt", { commandId: "interrupted" })).receipt,
    ).toMatchObject({ status: "unknown" });
    expect(
      (await request("command.receipt", { commandId: "prompt-stable" }))
        .receipt,
    ).toMatchObject({ status: "completed", sessionId: session.id });
    const duplicate = await request("session.create", {}, "create-stable");
    expect(duplicate).toMatchObject({
      duplicate: true,
      receipt: { sessionId: session.id, status: "completed" },
    });
    expect((await request("session.current")).session).toBeNull();
    await request("session.resume", { sessionId: session.id });
    const snapshot = await request("session.current");
    expect(snapshot).toMatchObject({
      runStatus: "completed",
      runId: expect.any(String),
      hostInstanceId: nextHello.hostInstanceId,
    });
    const events = await request("events.read", { sessionId: session.id });
    expect(
      events.filter((event: any) => event.type === "run.start"),
    ).toHaveLength(1);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

it("does not attribute another scope's run to a queued command with the same ID", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-scoped-run-receipts-"));
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  };
  const heldStart = deferred();
  const allowStart = deferred();
  const enteredProvider = deferred();
  const finishProvider = deferred();
  const finishedA = deferred();
  const finishedB = deferred();
  const starts: AgentEvent[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<
    string,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  const parser = new JsonLines((raw) => {
    const frame = raw as any;
    if (frame.type === "event" && frame.event.type === "run.start")
      starts.push(frame.event);
    if (frame.type !== "response") return;
    const key = `${frame.scope}:${frame.id}`;
    const request = pending.get(key);
    pending.delete(key);
    if (frame.error) request?.reject(Error(frame.error));
    else request?.resolve(frame.result);
  });
  output.on("data", (chunk) => parser.push(chunk));
  const request = (
    scope: string,
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ) =>
    new Promise<any>((resolve, reject) => {
      pending.set(`${scope}:${id}`, { resolve, reject });
      input.write(JSON.stringify({ scope, id, method, params }) + "\n");
    });
  const open = Runtime.open.bind(Runtime);
  let runtime!: Runtime;
  vi.spyOn(Runtime, "open").mockImplementation(async (options) => {
    runtime = await open(options);
    return runtime;
  });
  let server: Awaited<ReturnType<typeof serveRpc>> | undefined;
  try {
    server = await serveRpc(
      { cwd: home, home, demo: true },
      { input, output, error: new PassThrough() },
    );
    const session = await request("a", "create", "session.create");
    await request("b", "resume", "session.resume", { sessionId: session.id });
    const agent = await runtime.agent(session);
    vi.spyOn(agent.options.provider, "stream").mockImplementation(
      async function* ({ signal }) {
        enteredProvider.resolve();
        await finishProvider.promise;
        signal.throwIfAborted();
      },
    );
    const append = runtime.store.append.bind(runtime.store);
    vi.spyOn(runtime.store, "append").mockImplementation(async (...args) => {
      if (args[1] === "run.start") {
        heldStart.resolve();
        await allowStart.promise;
      }
      return append(...args);
    });
    const finish = runtime.store.finishCommand.bind(runtime.store);
    vi.spyOn(runtime.store, "finishCommand").mockImplementation(
      async (args) => {
        await finish(args);
        if (args.id === "same-id")
          (args.scope === "a" ? finishedA : finishedB).resolve();
      },
    );

    await request("a", "same-id", "prompt", { text: "first" });
    await heldStart.promise;
    await request("b", "same-id", "prompt", { text: "second" });
    allowStart.resolve();
    await enteredProvider.promise;
    await request("b", "cancel", "cancel");
    await finishedB.promise;
    finishProvider.resolve();
    await finishedA.promise;

    const b = await request("b", "receipt-b", "command.receipt", {
      commandId: "same-id",
    });
    const a = await request("a", "receipt-a", "command.receipt", {
      commandId: "same-id",
    });
    expect(b.receipt).toMatchObject({ scope: "b", status: "failed" });
    expect(b.receipt.runId).toBeUndefined();
    expect(a.receipt.runId).toBe(starts[0]!.data.runId);
    expect(new Set(starts.map((event) => event.data.runId)).size).toBe(1);
  } finally {
    allowStart.resolve();
    finishProvider.resolve();
    await server?.close();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
