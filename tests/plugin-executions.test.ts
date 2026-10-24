import { expect, it } from "vitest";
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
  } finally {
    finish?.("cleanup");
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("cancels through the host control lane without replaying the invocation", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { vi } = await import("vitest");
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
