import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/runtime/src/index.ts";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";

it("authorizes read-only plan history by session and never approves a historical revision", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-plan-rpc-")),
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
  await seed.agent(session);
  await seed.setPlanning(session, true);
  const old = await seed.planning.propose(session.id, {
    title: "Old",
    steps: ["Old step"],
    validation: "Old validation",
  });
  const current = await seed.planning.propose(session.id, {
    title: "Current",
    steps: ["Current step"],
    validation: "Current validation",
  });
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
  try {
    const hello = await owner.request("hello");
    expect(hello.methods).toContain("plan.history");
    expect(hello.methods).toContain("plan.version");
    await owner.request("session.resume", { sessionId: session.id });
    await remote("hello");
    // A confirmed phone has default control; explicitly exclude this task to
    // retain the denial regression before granting the read-only override.
    await owner.request("session.access", { deviceId, role: null });
    await expect(
      remote("session.resume", { sessionId: session.id }),
    ).rejects.toThrow(/denied/);
    await expect(
      remote("plan.history", { sessionId: session.id }),
    ).rejects.toThrow(/selected/);
    await owner.request("session.access", { deviceId, role: "view" });
    await remote("session.resume", { sessionId: session.id });
    expect(
      await remote("plan.history", { sessionId: session.id }),
    ).toMatchObject({ items: [{ id: current.id }, { id: old.id }] });
    expect(
      await remote("plan.version", { sessionId: session.id, id: old.id }),
    ).toEqual(old);
    await expect(
      remote("plan.history", { sessionId: other.id }),
    ).rejects.toThrow(/selected/);
    await expect(
      remote("plan.version", { sessionId: session.id, id: "../escape" }),
    ).rejects.toThrow();
    await expect(
      remote("plan.execute", { sessionId: session.id, id: old.id }),
    ).rejects.toThrow(/denied/);
    await expect(
      owner.request("plan.execute", { sessionId: session.id, id: old.id }),
    ).rejects.toThrow(/changed/);
    expect(
      await owner.request("plan.read", { sessionId: session.id }),
    ).toMatchObject({ active: true, plan: { id: current.id } });
    await owner.request("session.access", { deviceId, role: null });
    await expect(
      remote("plan.version", { sessionId: session.id, id: old.id }),
    ).rejects.toThrow(/denied|selected/);
  } finally {
    await bridge.close();
    await owner.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
