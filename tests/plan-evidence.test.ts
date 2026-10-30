import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as z from "zod";
import { Runtime } from "../packages/runtime/src/index.ts";

it("binds evidence at tool start, preserves ambiguity and delegation, and restores scoped proof", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-plan-evidence-")),
  );
  const cwd = join(home, "work");
  await mkdir(cwd);
  const open = () =>
    Runtime.open({
      home,
      cwd,
      demo: true,
      trusted: true,
      approve: async () => true,
    });
  let runtime = await open();
  try {
    const session = await runtime.session();
    const agent = await runtime.agent(session);
    await runtime.setPlanning(session, true);
    const plan = await runtime.planning.propose(session.id, {
      title: "Evidence",
      steps: ["one", "two"],
      validation: "tests",
    });
    await runtime.approvePlan(session, plan.id);
    const signal = new AbortController().signal;
    await agent.executeTool(
      "write_file",
      { path: "unassigned.txt", content: "unassigned" },
      "unassigned",
    );
    await runtime.planning.updateStep(session.id, {
      planId: plan.id,
      step: 1,
      status: "in_progress",
    });
    // A tool changes the reported step while in flight: its write must keep the initial step.
    runtime.tools.register({
      name: "moving",
      description: "fixture",
      schema: z.object({}),
      async execute(_, ctx) {
        await runtime.planning.updateStep(session.id, {
          planId: plan.id,
          step: 1,
          status: "completed",
        });
        await runtime.planning.updateStep(session.id, {
          planId: plan.id,
          step: 2,
          status: "in_progress",
        });
        await runtime.changes.update(
          session.id,
          join(cwd, "one.txt"),
          signal,
          () => "one",
          undefined,
          ctx.runId,
          { callId: ctx.callId, plan: ctx.plan },
        );
        return { text: "completed with stable association" };
      },
    });
    await agent.executeTool("moving", {}, "moving");
    await runtime.planning.updateStep(session.id, {
      planId: plan.id,
      step: 1,
      status: "in_progress",
    });
    await agent.executeTool(
      "write_file",
      { path: "ambiguous.txt", content: "ambiguous" },
      "ambiguous",
    );
    await runtime.planning.updateStep(session.id, {
      planId: plan.id,
      step: 1,
      status: "completed",
    });
    // Child model performs a file write; delegated association remains the parent's step 2.
    vi.spyOn(runtime, "provider").mockResolvedValue({
      id: "fixture",
      model: "fixture",
      contextWindow: 32000,
      async *stream({ messages }) {
        yield {
          type: "done",
          message: {
            role: "assistant",
            text: "child result",
            timestamp: Date.now(),
            ...(messages.at(-1)?.role === "tool"
              ? {}
              : {
                  toolCalls: [
                    {
                      id: "child-write",
                      name: "write_file",
                      arguments: { path: "child.txt", content: "child" },
                    },
                  ],
                }),
          },
          usage: { input: 0, output: 0, cost: 0 },
        };
      },
    });
    await agent.executeTool("subagent", { task: "write child" }, "delegate");
    const other = await runtime.session();
    await runtime.changes.update(
      other.id,
      join(cwd, "other.txt"),
      signal,
      () => "other",
      undefined,
      undefined,
      {
        callId: "foreign",
        plan: { sessionId: session.id, planId: plan.id, step: 2 },
      },
    );
    await runtime.close();
    runtime = await open();
    await runtime.planning.load(session.id);
    const progress = await runtime.planProgress(session.id);
    expect(progress!.steps[0]!.evidence!.reliable).toBe(1);
    expect(
      progress!.steps[0]!.evidence!.tools.some(
        (t) => t.name === "moving" && t.status === "completed",
      ),
    ).toBe(true);
    expect(progress!.steps[1]!.evidence!.reliable).toBe(1);
    expect(progress!.unassigned!.reliable).toBe(2);
    await runtime.planning.load(other.id);
    expect(await runtime.planProgress(other.id)).toBeNull();
    const { RpcWorkflows } = await import("../packages/cli/src/rpc-workflows.ts");
    const rpc = new RpcWorkflows(runtime);
    const tool = progress!.steps[0]!.evidence!.tools.find(
      (t) => t.name === "moving",
    )!;
    const ownerAgent = await runtime.agent(session),
      otherAgent = await runtime.agent(other);
    const params = { planId: plan.id, owner: tool.sessionId, seq: tool.seq };
    expect(
      await rpc.handle("plan.evidence", params, session, ownerAgent, "owner"),
    ).toMatchObject({ data: "completed with stable association" });
    await expect(
      rpc.handle("plan.evidence", params, other, otherAgent, "owner"),
    ).rejects.toThrow(/task tree/);
    expect(
      (
        await runtime.review.list(session.id, { planId: plan.id, step: 2 })
      ).items.map((e) => e.path),
    ).toEqual([join(cwd, "child.txt")]);
    await runtime.setPlanning(session, true);
    const replacement = await runtime.planning.propose(session.id, {
      title: "new",
      steps: ["new"],
      validation: "check",
    });
    await runtime.approvePlan(session, replacement.id);
    expect((await runtime.planProgress(session.id))?.unassigned).toEqual({
      reliable: 0,
      observed: 0,
      tools: [],
    });
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
