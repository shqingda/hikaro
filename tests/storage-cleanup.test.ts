import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";

const homes: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-cleanup-"));
  homes.push(home);
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  runtimes.push(runtime);
  const session = await runtime.session();
  const folder = join(
    home,
    "changes",
    createHash("sha256").update(session.id).digest("hex"),
  );
  await mkdir(folder, { recursive: true });
  const text = "old snapshot";
  const path = join(
    folder,
    createHash("sha256").update(text).digest("hex") + ".txt",
  );
  await writeFile(path, text);
  await runtime.store.saveDraft(session.id, "unsent");
  await runtime.store.append(session.id, "message", {
    message: { role: "user", text: "keep transcript", timestamp: 1 },
  });
  return { home, runtime, session, path, folder };
}

it("requires an unchanged preview, deletes only eligible snapshots, and preserves recovery data", async () => {
  const { home, runtime, session, path, folder } = await setup();
  const record = join(folder, randomUUID() + ".json");
  await writeFile(record, "metadata retained");
  const credential = join(home, "auth.json");
  await writeFile(credential, "private credential");
  const preview = await runtime.previewCleanup(session.id);
  expect(preview.bytes).toBe(12);
  expect(await readFile(path, "utf8")).toBe("old snapshot");
  expect(preview.warning).toMatch(/diff.*rollback/i);
  const result = await runtime.cleanupStorage(session.id, preview.token);
  expect(result.bytes).toBe(preview.bytes);
  expect(result.files).toBe(1);
  await expect(readFile(path)).rejects.toThrow();
  expect(await readFile(record, "utf8")).toBe("metadata retained");
  expect(await readFile(credential, "utf8")).toBe("private credential");
  expect(await runtime.store.draft(session.id)).toBe("unsent");
  expect((await runtime.store.messages(session.id))[0]?.text).toBe(
    "keep transcript",
  );
  await expect(
    runtime.cleanupStorage(session.id, preview.token),
  ).rejects.toThrow(/preview/i);
});

it("refuses stale previews and foreign leases without deleting files", async () => {
  const { runtime, session, path } = await setup();
  const preview = await runtime.previewCleanup(session.id);
  await writeFile(path, "changed");
  await expect(
    runtime.cleanupStorage(session.id, preview.token),
  ).rejects.toThrow(/preview/i);
  const next = await runtime.previewCleanup(session.id);
  const lease = await runtime.store.acquireLease(session.id, randomUUID());
  await expect(runtime.cleanupStorage(session.id, next.token)).rejects.toThrow(
    /running elsewhere/i,
  );
  expect(await readFile(path, "utf8")).toBe("changed");
  await runtime.store.releaseLease(session.id, lease!);
});

it("never follows links or deletes shared hardlinks and retained tool outputs", async () => {
  const { runtime, session, home, path, folder } = await setup();
  const external = join(home, "outside");
  await writeFile(external, "never delete");
  await symlink(external, join(folder, "a".repeat(64) + ".txt"));
  await link(path, join(folder, "b".repeat(64) + ".txt"));
  const outputs = join(home, "outputs", session.id);
  await mkdir(outputs, { recursive: true });
  const output = join(outputs, randomUUID() + ".log");
  await writeFile(output, "saved output");
  const preview = await runtime.previewCleanup(session.id);
  expect(preview.files).toBe(0);
  expect(preview.usage.toolOutputs).toBe(12);
  await runtime.cleanupStorage(session.id, preview.token);
  expect(await readFile(external, "utf8")).toBe("never delete");
  expect(await readFile(output, "utf8")).toBe("saved output");
});
