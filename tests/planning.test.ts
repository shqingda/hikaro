import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Runtime } from "../packages/runtime/src/index.ts";
it("persists read-only planning, blocks writes and replacement tools even with full access, and binds approval to a revision", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-"));
  const options = {
    home,
    cwd: home,
    demo: true,
    permissionMode: "full" as const,
    approve: async () => true,
  };
  let runtime = await Runtime.open(options);
  try {
    const session = await runtime.session();
    const agent = await runtime.agent(session);
    await writeFile(join(home, "file.txt"), "original");
    const peer = await Runtime.open(options);
    const peerAgent = await peer.agent(await peer.session(session.id));
    await runtime.setPlanning(session, true);
    try {
      expect(
        (
          await peerAgent.invoke(
            "write_file",
            { path: "file.txt", content: "bad", expected: "original" },
            new AbortController().signal,
          )
        ).text,
      ).toContain("Plan mode");
    } finally {
      await peer.close();
    }
    expect(
      (
        await agent.invoke(
          "read_file",
          { path: "file.txt" },
          new AbortController().signal,
        )
      ).text,
    ).toContain("original");
    for (const [name, args] of [
      [
        "write_file",
        { path: "file.txt", content: "bad", expected: "original" },
      ],
      ["shell", { command: "touch bad" }],
      ["codemode", {}],
      ["subagent", { task: "write" }],
    ] as const) {
      expect(
        await agent.invoke(name, args, new AbortController().signal),
      ).toMatchObject({
        isError: true,
        text: expect.stringContaining("Plan mode"),
      });
    }
    expect(await readFile(join(home, "file.txt"), "utf8")).toBe("original");
    runtime.tools.remove("read_file");
    runtime.tools.register({
      name: "read_file",
      description: "replacement",
      schema: z.object({}),
      execute: async () => {
        throw Error("Executed replacement");
      },
    });
    expect(
      (await agent.invoke("read_file", {}, new AbortController().signal)).text,
    ).toContain("Plan mode");
    const release = agent.holdQueue();
    const queued = agent.prompt("pending").catch((error) => error.name);
    await expect(runtime.setPlanning(session, false)).rejects.toThrow(/queued/);
    agent.cancel();
    release();
    await queued;
    const plan = await runtime.planning.propose(session.id, {
      title: "Fix",
      steps: ["Edit file"],
      validation: "Read back",
    });
    const fork = await runtime.fork(session);
    expect(runtime.planning.get(fork.id)).toMatchObject({
      active: true,
      plan: { title: "Fix" },
    });
    expect(runtime.planning.get(fork.id).plan!.id).not.toBe(plan.id);
    await expect(runtime.approvePlan(session, "stale")).rejects.toThrow(
      /changed/,
    );
    await runtime.close();
    runtime = await Runtime.open(options);
    const reopened = await runtime.session(session.id);
    await runtime.agent(reopened);
    expect(runtime.planning.get(session.id)).toMatchObject({
      active: true,
      plan: { id: plan.id },
    });
    const approved = await runtime.approvePlan(reopened, plan.id);
    expect(approved.title).toBe("Fix");
    expect(runtime.planning.get(session.id).active).toBe(false);
    expect(await readFile(join(home, "file.txt"), "utf8")).toBe("original");
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
