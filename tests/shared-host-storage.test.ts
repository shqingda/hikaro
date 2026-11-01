import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("atomically elects one host and persists scoped session access and view recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-host-storage-"));
  const path = join(home, "sessions.sqlite");
  const a = await SQLiteStore.open(path),
    b = await SQLiteStore.open(path);
  try {
    const claims = await Promise.all([
      a.claimHost("/workspace", "a"),
      b.claimHost("/workspace", "b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await a.releaseHost("/workspace", claims[0] ? "b" : "a");
    expect(await b.claimHost("/workspace", "other")).toBe(false);
    await a.releaseHost("/workspace", claims[0] ? "a" : "b");
    expect(await b.claimHost("/workspace", "other")).toBe(true);
    const session = await a.createSession("/workspace");
    await a.setSessionAccess("/workspace", session.id, "client", "control");
    await a.saveClientView("/workspace", "client", session.id);
    expect(await b.sessionRole("/workspace", session.id, "client")).toBe(
      "control",
    );
    expect(await b.clientView("/workspace", "client")).toBe(session.id);
    expect(await b.sessionRole("/other", session.id, "client")).toBeNull();
    expect(await b.sessions(0, 20, "/workspace", "", "stranger")).toEqual([]);
    expect((await b.sessions(0, 20, "/workspace", "", "client"))[0]?.id).toBe(
      session.id,
    );
    await expect(
      a.setSessionAccess("/other", session.id, "client", "control"),
    ).rejects.toThrow(/workspace/);
    await b.revokeScope("/workspace", "client");
    expect(await a.sessionRole("/workspace", session.id, "client")).toBeNull();
    expect(await a.clientView("/workspace", "client")).toBeNull();
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await rm(home, { recursive: true, force: true });
  }
});
