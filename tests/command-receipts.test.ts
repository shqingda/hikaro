import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteStore } from "../packages/storage/src/index.ts";

const stores = new Set<SQLiteStore>();
const directories: string[] = [];
afterEach(async () => {
  await Promise.all([...stores].map((store) => store.close()));
  stores.clear();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function open(path: string) {
  const store = await SQLiteStore.open(path);
  stores.add(store);
  return store;
}
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "hikaro-receipts-"));
  directories.push(workspace);
  const path = join(workspace, "sessions.sqlite");
  const store = await open(path);
  const session = await store.createSession(workspace);
  return { workspace, path, store, session };
}

it("claims a scoped command once across connections and rejects payload conflicts", async () => {
  const { workspace, path, store, session } = await fixture();
  const second = await open(path);
  const command = {
    workspace,
    scope: "local",
    id: "send-once",
    method: "prompt" as const,
    digest: "a".repeat(64),
    hostInstanceId: "host-a",
    sessionId: session.id,
  };
  const claims = await Promise.all([
    store.acceptCommand(command),
    second.acceptCommand(command),
  ]);
  expect(claims.filter((claim) => claim.inserted)).toHaveLength(1);
  for (const claim of claims)
    expect(claim.receipt).toMatchObject({
      id: command.id,
      status: "accepted",
      digest: command.digest,
      sessionId: session.id,
    });
  await expect(
    second.acceptCommand({ ...command, digest: "b".repeat(64) }),
  ).rejects.toThrow(/conflict/i);
  await expect(
    second.acceptCommand({ ...command, method: "cancel" }),
  ).rejects.toThrow(/conflict/i);

  const secondary = { ...command, scope: "secondary" };
  const otherWorkspace = {
    ...command,
    workspace: join(workspace, "other"),
    sessionId: null,
  };
  expect(await second.commandReceipt(secondary)).toBeNull();
  expect(await second.commandReceipt(otherWorkspace)).toBeNull();
  expect((await second.acceptCommand(secondary)).inserted).toBe(true);
  expect((await second.acceptCommand(otherWorkspace)).inserted).toBe(true);
});

it("retains accepted intent after reopen without guessing another host's outcome", async () => {
  const { workspace, path, store, session } = await fixture();
  const command = {
    workspace,
    scope: "local",
    id: "interrupted-intent",
    method: "prompt" as const,
    digest: "c".repeat(64),
    hostInstanceId: "host-original",
    sessionId: session.id,
  };
  await store.acceptCommand(command);
  await store.close();
  stores.delete(store);
  const reopened = await open(path);
  const differentHost = { ...command, hostInstanceId: "host-new" };
  expect(await reopened.commandReceipt(differentHost)).toMatchObject({
    id: command.id,
    status: "unknown",
  });
  expect(await reopened.acceptCommand(differentHost)).toMatchObject({
    inserted: false,
    receipt: { status: "unknown" },
  });
  // Observing from another host must not rewrite an owner's live intent.
  expect(await reopened.commandReceipt(command)).toMatchObject({
    status: "accepted",
  });
  await reopened.finishCommand({
    ...command,
    status: "completed",
    runId: "run-1",
  });
  expect(await reopened.commandReceipt(differentHost)).toMatchObject({
    status: "completed",
    sessionId: session.id,
    runId: "run-1",
  });

  const failed = { ...command, id: "failed-intent" };
  await reopened.acceptCommand(failed);
  await reopened.finishCommand({
    ...failed,
    status: "failed",
    error: "Provider failed after starting",
  });
  expect(
    await reopened.commandReceipt({ ...failed, hostInstanceId: "host-new" }),
  ).toMatchObject({
    status: "failed",
    error: "Provider failed after starting",
  });
});

it("treats legacy unscoped claims as unknown without disclosing their session", async () => {
  const { workspace, path, store, session } = await fixture();
  const legacy = new DatabaseSync(path);
  try {
    legacy
      .prepare("INSERT INTO commands(id,sessionId,createdAt) VALUES(?,?,?)")
      .run("legacy-command", session.id, 1);
  } finally {
    legacy.close();
  }
  const command = {
    workspace,
    scope: "new-device",
    id: "legacy-command",
    method: "prompt" as const,
    digest: "d".repeat(64),
    hostInstanceId: "host-new",
    sessionId: null,
  };
  const receipt = await store.commandReceipt(command);
  expect(receipt).toMatchObject({
    status: "unknown",
    digest: null,
    sessionId: null,
  });
  expect(await store.acceptCommand(command)).toMatchObject({
    inserted: false,
    receipt: { status: "unknown", digest: null, sessionId: null },
  });
  expect(
    await store.commandReceipt({
      ...command,
      workspace: join(workspace, "other"),
    }),
  ).toBeNull();
});
