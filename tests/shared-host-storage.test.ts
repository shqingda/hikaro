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
    await a.setSessionAccess("/workspace", session.id, "device", "control");
    await a.saveClientView("/workspace", "device", session.id);
    expect(await b.sessionRole("/workspace", session.id, "device")).toBe(
      "control",
    );
    expect(await b.clientView("/workspace", "device")).toBe(session.id);
    expect(await b.sessionRole("/other", session.id, "device")).toBeNull();
    expect(await b.sessions(0, 20, "/workspace", "", "stranger")).toEqual([]);
    expect((await b.sessions(0, 20, "/workspace", "", "device"))[0]?.id).toBe(
      session.id,
    );
    await expect(
      a.setSessionAccess("/other", session.id, "device", "control"),
    ).rejects.toThrow(/workspace/);
    await b.revokeScope("/workspace", "device");
    expect(await a.sessionRole("/workspace", session.id, "device")).toBeNull();
    expect(await a.clientView("/workspace", "device")).toBeNull();
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await rm(home, { recursive: true, force: true });
  }
});
