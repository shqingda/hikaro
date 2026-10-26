import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";

it("cancels only the owned plugin invocation and holds its lease until code settles", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plugin-cancel-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  let finish!: (text: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal!: AbortSignal;
  runtime.plugins.commands.set("wait", async (_args, context) => {
    signal = context.signal;
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  try {
    const session = await runtime.session();
    const work = runtime.invokePlugin(session, "wait", "command", "", {
      invocationId: "first",
      scope: "owner",
    });
    const outcome = work.catch((error: unknown) => error);
    await ready;
    expect(() =>
      runtime.pluginRuns.cancel(session.id, "first", "other"),
    ).toThrow(/not found/i);
    expect(() =>
      runtime.pluginRuns.cancel(session.id, "second", "owner"),
    ).toThrow(/not found/i);
    runtime.pluginRuns.cancel(session.id, "first", "owner");
    expect(signal.aborted).toBe(true);
    expect(runtime.pluginRuns.current(session.id)).toMatchObject({
      invocationId: "first",
      state: "cancelling",
    });
    expect(
      await runtime.store.acquireLease(session.id, "competitor"),
    ).toBeUndefined();
    finish("late result");
    expect(String(await outcome)).toMatch(/cancelled/i);
    expect(runtime.pluginRuns.current(session.id)).toBeUndefined();
    expect(
      (await runtime.store.messages(session.id)).some((m) =>
        m.text.includes("late result"),
      ),
    ).toBe(false);
    const lease = await runtime.store.acquireLease(session.id, "competitor");
    expect(lease).toBeTruthy();
    await runtime.store.releaseLease(session.id, lease!);
    const nextReady = new Promise<void>((resolve) => {
      started = resolve;
    });
    const nextOutcome = runtime
      .invokePlugin(session, "wait", "command", "", {
        invocationId: "second",
        scope: "owner",
      })
      .catch((error: unknown) => error);
    await nextReady;
    expect(() =>
      runtime.pluginRuns.cancel(session.id, "first", "owner"),
    ).toThrow(/not found/i);
    expect(signal.aborted).toBe(false);
    finish("successor result");
    expect(await nextOutcome).toBe("successor result");
  } finally {
    finish?.("cleanup");
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("accepts cancellation while the final checkpoint is still pending", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plugin-checkpoint-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  let returned = false;
  runtime.plugins.commands.set("result", async () => {
    returned = true;
    return "cancelled result";
  });
  let reached!: () => void;
  const checking = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const renew = runtime.store.renewLease.bind(runtime.store);
  const spy = vi
    .spyOn(runtime.store, "renewLease")
    .mockImplementation(async (...args) => {
      if (returned) {
        reached();
        await gate;
      }
      return renew(...args);
    });
  let outcome: Promise<unknown> | undefined;
  try {
    const session = await runtime.session();
    outcome = runtime
      .invokePlugin(session, "result", "command", "", {
        invocationId: "checking",
        scope: "owner",
      })
      .catch((error: unknown) => error);
    await checking;
    expect(
      runtime.pluginRuns.cancel(session.id, "checking", "owner"),
    ).toMatchObject({ accepted: true });
    expect(runtime.pluginRuns.current(session.id)).toMatchObject({
      state: "cancelling",
    });
    expect(
      await runtime.store.acquireLease(session.id, "competitor"),
    ).toBeUndefined();
    release();
    expect(String(await outcome)).toMatch(/cancelled/i);
    expect(
      (await runtime.store.events(session.id))
        .filter((event) => event.type === "plugin.end")
        .map((event) => event.data.status),
    ).toEqual(["cancelled"]);
    expect(await runtime.store.messages(session.id)).toEqual([]);
  } finally {
    release();
    await outcome;
    spy.mockRestore();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["message", "plugin.end"])(
  "rejects cancellation while persisting %s in the committing phase",
  async (blockedType) => {
    const home = await mkdtemp(join(tmpdir(), "hikaro-plugin-commit-"));
    const runtime = await Runtime.open({
      home,
      cwd: home,
      demo: true,
      approve: async () => true,
    });
    let reached!: () => void;
    const persisting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: AbortSignal;
    runtime.plugins.commands.set("result", async (_args, context) => {
      signal = context.signal;
      return "saved result";
    });
    const append = runtime.store.append.bind(runtime.store);
    const spy = vi
      .spyOn(runtime.store, "append")
      .mockImplementation(async (...args) => {
        if (args[1] === blockedType) {
          reached();
          await gate;
        }
        return append(...args);
      });
    let work: Promise<unknown> | undefined;
    try {
      const session = await runtime.session();
      work = runtime.invokePlugin(session, "result", "command", "", {
        invocationId: "committing",
        scope: "owner",
      });
      await persisting;
      expect(() =>
        runtime.pluginRuns.cancel(session.id, "committing", "owner"),
      ).toThrow(/committing.*cannot be cancelled/i);
      runtime.pluginRuns.close();
      expect(signal.aborted).toBe(false);
      expect(runtime.pluginRuns.current(session.id)).toMatchObject({
        invocationId: "committing",
        state: "committing",
      });
      expect(
        await runtime.store.acquireLease(session.id, "competitor"),
      ).toBeUndefined();
      release();
      expect(await work).toBe("saved result");
      expect(
        (await runtime.store.events(session.id))
          .filter((event) => event.type === "plugin.end")
          .map((event) => event.data.status),
      ).toEqual(["completed"]);
      expect(
        (await runtime.store.messages(session.id)).filter((message) =>
          message.text.includes("saved result"),
        ),
      ).toHaveLength(1);
      expect(runtime.pluginRuns.current(session.id)).toBeUndefined();
    } finally {
      release();
      await work?.catch(() => {});
      spy.mockRestore();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("cancels through the host control lane without replaying the invocation", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { serveSharedHost } = await import("../apps/cli/src/shared-host.ts");
  const { SharedHostClient } = await import("../packages/host/src/client.ts");
  const home = await mkdtemp(join(tmpdir(), "hikaro-plugin-rpc-"));
  await writeFile(
    join(home, "plugin.mjs"),
    `import { writeFile } from 'node:fs/promises'; export default {id:'cancel-proof',apiVersion:1,setup(api){api.registerCommand('wait',async (_,ctx)=>{const done=new Promise(resolve=>ctx.signal.addEventListener('abort',()=>resolve('late-result'),{once:true})); await writeFile(${JSON.stringify(join(home, "started"))},'ready'); return done;})}}`,
  );
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: [{ path: "plugin.mjs", trusted: true }] }),
  );
  const host = await serveSharedHost({ home, cwd: home, demo: true });
  const owner = await SharedHostClient.connect({
    home,
    cwd: home,
    clientId: "owner",
  });
  const other = await SharedHostClient.connect({
    home,
    cwd: home,
    clientId: "other",
  });
  try {
    await owner.request("hello");
    await other.request("hello");
    const session = await owner.request("session.create");
    await other.request("session.resume", { sessionId: session.id });
    const params = { name: "wait", invocationId: "cancel-me" };
    const outcome = owner
      .request("plugins.invoke", params, false, { id: "plugin-first" })
      .catch((error) => error);
    await vi.waitFor(async () =>
      expect(await readFile(join(home, "started"), "utf8")).toBe("ready"),
    );
    await expect(
      other.request("plugins.cancel", { invocationId: "cancel-me" }),
    ).rejects.toThrow(/not found/);
    expect(
      await owner.request("plugins.cancel", { invocationId: "cancel-me" }),
    ).toMatchObject({ accepted: true });
    expect(String(await outcome)).toMatch(/cancelled/i);
    expect(
      await owner.request("plugins.invoke", params, false, {
        id: "plugin-first",
      }),
    ).toMatchObject({ duplicate: true, receipt: { status: "failed" } });
  } finally {
    await owner.close();
    await other.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("accepts cancellation that arrives before the invocation acquires its lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plugin-early-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  let ran = false;
  runtime.plugins.commands.set("wait", async () => {
    ran = true;
    return "should not run";
  });
  try {
    const session = await runtime.session();
    const outcome = runtime
      .invokePlugin(session, "wait", "command", "", {
        invocationId: "early",
        scope: "owner",
      })
      .catch((error: unknown) => error);
    // Still awaiting idle/lease: only the owner's own invocation may be cancelled.
    expect(() =>
      runtime.pluginRuns.cancel(session.id, "early", "other"),
    ).toThrow(/not found/i);
    expect(runtime.pluginRuns.cancel(session.id, "early", "owner")).toEqual({
      accepted: true,
      invocationId: "early",
    });
    expect(String(await outcome)).toMatch(/cancelled/i);
    expect(ran).toBe(false);
    expect(runtime.pluginRuns.current(session.id)).toBeUndefined();
    expect(
      await runtime.store.acquireLease(session.id, "competitor"),
    ).toBeTruthy();
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
