import { expect, it } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { ChangeJournal } from "../packages/tools/src/changes.ts";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";
import type { ClientConnection } from "../packages/client-core/src/connection.ts";
import { MobileInspection } from "../apps/mobile/src/inspection.ts";

it("reads complete images and paged diffs through a view-only device and rejects foreign tasks and revoked access", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-mobile-inspection-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  const deviceId = randomToken(),
    identity = createIdentity();
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: "wss://fixture.example",
      hostId: randomToken(),
      publicKey: createIdentity().publicKey,
      devices: { [deviceId]: { publicKey: identity.publicKey } },
    }),
    { mode: 0o600 },
  );
  const db = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await db.createSession(cwd),
    foreign = await db.createSession(cwd);
  const data = Buffer.alloc(100000, 71).toString("base64");
  const event = await db.append(session.id, "message", {
    message: {
      role: "user",
      timestamp: 1,
      text: "看图",
      images: [{ mimeType: "image/png", data }],
    },
  });
  await db.close();
  const file = join(cwd, "sample.ts"),
    journal = new ChangeJournal(home);
  await writeFile(file, "before\n");
  const after = "中文😀\n".repeat(5000) + "末尾";
  await journal.update(
    session.id,
    file,
    new AbortController().signal,
    () => after,
    undefined,
    "run-mobile-1234",
  );
  const host = await serveSharedHost({ home, cwd, demo: true });
  const owner = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "inspection-owner",
  });
  const bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const methods: string[] = [];
  const request: ClientConnection["request"] = async (
    method,
    params = {},
    options,
  ) => {
    options?.beforeSend?.();
    methods.push(method);
    return dispatchRemote(bridge, deviceId, {
      id: randomUUID(),
      method,
      params,
    });
  };
  const reader = new MobileInspection(() => {});
  try {
    await owner.request("hello");
    await owner.request("session.resume", { sessionId: session.id });
    await owner.request("session.access", { deviceId, role: "view" });
    const hello = (await request("hello")) as { methods: string[] };
    expect(hello.methods).toContain("changes.diff");
    await request("session.resume", { sessionId: session.id });
    const client = {
      request,
      supports: (method: string) => hello.methods.includes(method),
      state: { canAct: true, session: { id: session.id } },
    };
    reader.bind(client);
    await reader.readImage(event.seq, 0, 1);
    expect(reader.state.image?.uri).toBe("data:image/png;base64," + data);
    expect(methods.filter((m) => m === "messages.content")).toHaveLength(3);
    await reader.listChanges();
    const entry = reader.state.changes!.items[0]!;
    expect(entry.runId).toBe("run-mobile-1234");
    const pages: string[] = [];
    for (let offset = 0; ;) {
      await reader.readDiff(entry.id, offset);
      const page = reader.state.diff!.page!;
      pages.push(page.data);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(pages.length).toBeGreaterThan(1);
    const diff = pages.join("");
    expect(diff).toContain("-before\n+中文😀");
    expect(diff).toContain("+末尾\n\\ No newline at end of file");
    expect(diff.match(/\+中文😀/g)).toHaveLength(5000);
    expect(await readFile(file, "utf8")).toBe(after);
    await expect(
      request("changes.diff", { sessionId: foreign.id, id: entry.id }),
    ).rejects.toThrow();
    await expect(
      request("changes.rollback", { sessionId: session.id, id: entry.id }),
    ).rejects.toThrow();
    await owner.request("session.access", { deviceId, role: null });
    await expect(reader.readDiff(entry.id)).rejects.toThrow();
    reader.bind(null);
    expect(reader.state.image).toBeNull();
    expect(reader.state.diff).toBeNull();
  } finally {
    reader.close();
    owner.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
