import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

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
