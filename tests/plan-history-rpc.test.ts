import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/runtime/src/index.ts";
import { serveSharedHost } from "../packages/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it("reads local plan history by session and never approves a historical revision", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-plan-rpc-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
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
  try {
    const hello = await owner.request("hello");
    expect(hello.methods).toContain("plan.history");
    expect(hello.methods).toContain("plan.version");
    await owner.request("session.resume", { sessionId: session.id });
    expect(
      await owner.request("plan.history", { sessionId: session.id }),
    ).toMatchObject({ items: [{ id: current.id }, { id: old.id }] });
    expect(
      await owner.request("plan.version", {
        sessionId: session.id,
        id: old.id,
      }),
    ).toEqual(old);
    await expect(
      owner.request("plan.history", { sessionId: other.id }),
    ).rejects.toThrow(/selected/);
    await expect(
      owner.request("plan.version", { sessionId: session.id, id: "../escape" }),
    ).rejects.toThrow();
    await expect(
      owner.request("plan.execute", { sessionId: session.id, id: old.id }),
    ).rejects.toThrow();
  } finally {
    await owner.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
