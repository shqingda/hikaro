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

it("derives paired-phone control within its workspace while preserving explicit view/off overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-default-phone-"));
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  try {
    const first = await store.createSession("/workspace");
    const other = await store.createSession("/other");
    expect(await store.sessionRole("/workspace", first.id, "phone", true)).toBe(
      "control",
    );
    expect(
      await store.sessionRole("/workspace", other.id, "phone", true),
    ).toBeNull();
    expect(
      await store.attachView("/workspace", "phone", first.id, false, true),
    ).toBe("control");
    await store.setSessionAccess("/workspace", first.id, "phone", "view");
    expect(await store.sessionRole("/workspace", first.id, "phone", true)).toBe(
      "view",
    );
    await store.setSessionAccess("/workspace", first.id, "phone", null);
    expect(
      await store.sessionRole("/workspace", first.id, "phone", true),
    ).toBeNull();
    expect(await store.sessionAccess("/workspace", first.id)).toEqual([
      { scope: "phone", role: null },
    ]);
    await expect(
      store.attachView("/workspace", "phone", first.id, false, true),
    ).rejects.toThrow("denied");
    const next = await store.createSession("/workspace");
    expect(
      (await store.sessions(0, 50, "/workspace", "", "phone", true)).map(
        (s) => s.id,
      ),
    ).toEqual([next.id]);
    expect(
      await store.sessionRole("/workspace", next.id, "phone", false),
    ).toBeNull();
    await store.setSessionAccess(
      "/workspace",
      next.id,
      "phone",
      "unknown" as never,
    );
    expect(
      await store.sessionRole("/workspace", next.id, "phone", true),
    ).toBeNull();
    expect(
      await store.sessions(0, 50, "/workspace", "", "phone", true),
    ).toEqual([]);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
