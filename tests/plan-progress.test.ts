import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planning } from "../packages/runtime/src/planning.ts";
import { planExecutionPrompt } from "../packages/runtime/src/plan-text.ts";

const proposal = {
  title: "Ship progress",
  steps: ["Add storage", "Add tool", "Add view"],
  validation: "Run tests",
};

it("tracks reported step progress only for the approved plan and survives restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-progress-"));
  try {
    let planning = new Planning(home);
    await planning.load("s");
    expect(planning.progress("s")).toBeNull();
    await planning.setActive("s", true);
    const plan = await planning.propose("s", proposal);
    // Not approved yet: read-only planning has no progress to update.
    expect(planning.progress("s")).toBeNull();
    await expect(
      planning.updateStep("s", {
        planId: plan.id,
        step: 1,
        status: "completed",
      }),
    ).rejects.toThrow(/approved/);

    const before = Date.now();
    await planning.approve("s", plan.id);
    expect(planning.progress("s")!.approvedAt).toBeGreaterThanOrEqual(before);
    expect(planning.progress("s")).toEqual({
      planId: plan.id,
      title: "Ship progress",
      approvedAt: expect.any(Number),
      steps: [
        { text: "Add storage", status: "pending" },
        { text: "Add tool", status: "pending" },
        { text: "Add view", status: "pending" },
      ],
    });

    await planning.updateStep("s", {
      planId: plan.id,
      step: 1,
      status: "completed",
      note: "Schema saved",
    });
    await planning.updateStep("s", {
      planId: plan.id,
      step: 2,
      status: "in_progress",
    });
    await expect(
      planning.updateStep("s", {
        planId: randomUUID(),
        step: 1,
        status: "completed",
      }),
    ).rejects.toThrow(/changed/);
    await expect(
      planning.updateStep("s", {
        planId: plan.id,
        step: 4,
        status: "completed",
      }),
    ).rejects.toThrow(/step/i);
    await expect(
      planning.updateStep("s", {
        planId: plan.id,
        step: 0,
        status: "completed",
      }),
    ).rejects.toThrow();
    await expect(
      planning.updateStep("s", {
        planId: plan.id,
        step: 1,
        status: "done" as never,
      }),
    ).rejects.toThrow();

    planning = new Planning(home);
    await planning.load("s");
    expect(planning.progress("s")?.steps).toEqual([
      { text: "Add storage", status: "completed", note: "Schema saved" },
      { text: "Add tool", status: "in_progress" },
      { text: "Add view", status: "pending" },
    ]);
    // get() keeps its established shape for existing clients.
    expect(Object.keys(planning.get("s")).sort()).toEqual(["active", "plan"]);

    // Re-entering Plan mode starts a new plan; old progress must not linger.
    await planning.setActive("s", true);
    expect(planning.progress("s")).toBeNull();
    const next = await planning.propose("s", proposal);
    expect(planning.progress("s")).toBeNull();
    await planning.approve("s", next.id);
    expect(planning.progress("s")?.planId).toBe(next.id);
    expect(
      planning.progress("s")?.steps.every((step) => step.status === "pending"),
    ).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("asks the model to report progress against the approved plan id", () => {
  const id = randomUUID();
  const text = planExecutionPrompt({ id, ...proposal });
  expect(text).toContain(`approved plan ${id}`);
  expect(text).toContain("update_plan_step");
  expect(text).toContain("1. Add storage");
});

it("offers update_plan_step to the model only while an approved plan executes", async () => {
  const { Runtime } = await import("../packages/runtime/src/index.ts");
  const home = await mkdtemp(join(tmpdir(), "hikaro-plan-tool-"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => true,
  });
  try {
    const session = await runtime.session();
    const agent = await runtime.agent(session);
    const policy = (
      agent as unknown as {
        options: {
          toolPolicy: {
            refresh(): Promise<void>;
            allowed(tool: unknown): boolean;
          };
        };
      }
    ).options.toolPolicy;
    const tool = runtime.tools.get("update_plan_step")!;
    const offered = async () => {
      await policy.refresh();
      return policy.allowed(tool);
    };
    expect(await offered()).toBe(false);
    await runtime.setPlanning(session, true);
    const plan = await runtime.planning.propose(session.id, proposal);
    expect(await offered()).toBe(false);
    await runtime.approvePlan(session, plan.id);
    expect(await offered()).toBe(true);
    expect(policy.allowed(runtime.tools.get("read_file")!)).toBe(true);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});
