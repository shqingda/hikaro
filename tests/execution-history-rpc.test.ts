import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";

it("keeps the host available after history with maximally escaped IDs and details", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-history-frame-")),
  );
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const seed = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => true,
  });
  const session = await seed.session();
  const field = "\u0001".repeat(4000);
  const ids = Array.from({ length: 20 }, (_, n) =>
    `n${n}-`.padEnd(128, "\u0001"),
  );
  for (const runId of ids) {
    await seed.store.append(session.id, "run.start", {
      runId,
      provider: field,
      model: field,
    });
    await seed.store.append(session.id, "run.end", {
      runId,
      status: "failed",
      error: field,
      usage: { output: "\u0001".repeat(2000) },
    });
  }
  await seed.close();
  const host = await serveSharedHost({ home, cwd, demo: true });
  const client = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "frame-check",
  });
  try {
    await client.request("session.resume", { sessionId: session.id });
    const page = await client.request("execution.history", {
      sessionId: session.id,
    });
    expect(page.items).toHaveLength(20);
    expect(
      page.items.every(
        (item: { detail: string; actions: unknown[] }) =>
          item.detail === "" && item.actions.length === 0,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(32 * 1024);
    const detail = await client.request("execution.history.detail", {
      sessionId: session.id,
      id: ids[0],
      snapshot: page.snapshot,
    });
    expect(detail).toMatchObject({ id: ids[0], state: "failed", actions: [] });
    expect(detail.detail).toContain(field);
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(128 * 1024);
    expect((await client.request("session.current")).session.id).toBe(
      session.id,
    );
    expect(
      (await client.request("execution.history", { sessionId: session.id }))
        .snapshot,
    ).toBe(page.snapshot);
  } finally {
    await client.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("authorizes complete run history for read-only clients without holding or replaying execution", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-history-rpc-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const deviceId = randomToken();
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: "wss://fixture.example",
      hostId: randomToken(),
      publicKey: createIdentity().publicKey,
      devices: { [deviceId]: { publicKey: createIdentity().publicKey } },
    }),
    { mode: 0o600 },
  );
  const seed = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => true,
  });
  const session = await seed.session(),
    other = await seed.session();
  for (let n = 0; n < 125; n++) {
    await seed.store.append(session.id, "run.start", {
      runId: `run-${n}`,
      operation: "fixture operation",
    });
    await seed.store.append(session.id, "run.end", {
      runId: `run-${n}`,
      status: "completed",
    });
  }
  await seed.store.append(other.id, "run.start", { runId: "foreign" });
  await seed.close();
  const host = await serveSharedHost({ home, cwd, demo: true });
  const owner = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "owner",
  });
  const bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const remote = (method: string, params: Record<string, unknown> = {}) =>
    bridge.request(method, params, false, { scope: deviceId });
  let release: (() => void) | undefined;
  try {
    const hello = await owner.request("hello");
    expect(hello.methods).toContain("execution.history");
    expect(hello.methods).toContain("execution.history.detail");
    await owner.request("session.resume", { sessionId: session.id });
    await remote("hello");
    // A confirmed phone has default control; explicitly exclude this task to
    // retain the denial regression before granting the read-only override.
    await owner.request("session.access", { deviceId, role: null });
    await expect(
      remote("session.resume", { sessionId: session.id }),
    ).rejects.toThrow(/denied/);
    await owner.request("session.access", { deviceId, role: "view" });
    await remote("session.resume", { sessionId: session.id });
    const page = await remote("execution.history", { sessionId: session.id });
    expect(page.items).toHaveLength(20);
    expect(page.items[0].id).toBe("run-124");
    expect(page.nextBefore).toBeGreaterThan(0);
    expect(
      await remote("execution.history.detail", {
        sessionId: session.id,
        id: "run-0",
      }),
    ).toMatchObject({ id: "run-0", state: "completed", actions: [] });
    expect(
      (
        await owner.request("execution.read", {
          sessionId: session.id,
          kind: "history",
        })
      ).length,
    ).toBe(100);
    await expect(
      remote("execution.history", { sessionId: other.id }),
    ).rejects.toThrow(/selected|denied/);
    await expect(
      remote("execution.history.detail", {
        sessionId: session.id,
        id: "foreign",
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      remote("execution.history.detail", {
        sessionId: session.id,
        id: "x".repeat(129),
      }),
    ).rejects.toThrow();
    await expect(
      remote("execution.history", {
        sessionId: session.id,
        snapshot: page.snapshot,
        before: -1,
      }),
    ).rejects.toThrow();
    await expect(
      owner.request("execution.action", {
        sessionId: session.id,
        kind: "history",
        id: "run-0",
        action: "stop",
      }),
    ).rejects.toThrow(/read-only/);
    // A normal request remains queued while both history reads use the bounded
    // control lane. No execution hold is required for the read-only device.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = SQLiteStore.prototype.sessions;
    const spy = vi
      .spyOn(SQLiteStore.prototype, "sessions")
      .mockImplementationOnce(async function (this: SQLiteStore, ...args) {
        entered();
        await gate;
        return sessions.apply(this, args);
      });
    const waiting = remote("session.list");
    await started;
    expect(
      (await remote("execution.history", { sessionId: session.id })).snapshot,
    ).toBe(page.snapshot);
    expect(
      (
        await remote("execution.history.detail", {
          sessionId: session.id,
          id: "run-0",
        })
      ).id,
    ).toBe("run-0");
    release?.();
    await waiting;
    spy.mockRestore();
    expect((await remote("session.current")).busy).toBe(false);
    await owner.request("session.access", { deviceId, role: null });
    await expect(
      remote("execution.history", { sessionId: session.id }),
    ).rejects.toThrow(/denied|selected/);
    const db = new DatabaseSync(join(home, "sessions.sqlite"));
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE sessionId=? AND type='run.start'",
          )
          .get(session.id)!.count,
      ).toBe(125);
    } finally {
      db.close();
    }
  } finally {
    release?.();
    vi.restoreAllMocks();
    await bridge.close();
    await owner.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
