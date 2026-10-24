import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, link } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
export const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        question: z.string().min(1).max(2000),
        options: z.array(z.string().min(1).max(300)).min(2).max(5).optional(),
      }),
    )
    .min(1)
    .max(3)
    .refine(
      (items) => new Set(items.map((q) => q.id)).size === items.length,
      "Question IDs must be unique",
    ),
});
export type Questions = z.infer<typeof questionsSchema>["questions"];
export const proposalSchema = z.object({
  title: z.string().min(1).max(200),
  steps: z.array(z.string().min(1).max(4000)).min(1).max(12),
  validation: z.string().min(1).max(4000),
});
const planSchema = proposalSchema.extend({ id: z.string().uuid() });
export const stepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
]);
export const stepUpdateSchema = z.object({
  planId: z.string().uuid(),
  step: z.number().int().min(1).max(12),
  status: stepStatusSchema,
  note: z.string().min(1).max(500).optional(),
});
const progressSchema = z.object({
  planId: z.string().uuid(),
  steps: z.array(
    z.object({
      status: stepStatusSchema,
      note: z.string().max(500).optional(),
    }),
  ),
});
const stateSchema = z.object({
  active: z.boolean(),
  plan: planSchema.optional(),
  versions: z.array(z.string().uuid()).default([]),
  incomplete: z.boolean().default(false),
  progress: progressSchema.optional(),
});
export type Plan = z.infer<typeof planSchema>;
/** Step status as reported by the model; it is not independent verification. */
export type PlanProgress = {
  planId: string;
  title: string;
  steps: Array<{
    text: string;
    status: z.infer<typeof stepStatusSchema>;
    note?: string;
  }>;
};
export type PlanHistory = {
  items: Array<{ id: string; title: string; revision: number }>;
  nextBefore: number | null;
  incomplete: boolean;
};
export class Planning {
  private states = new Map<string, z.infer<typeof stateSchema>>();
  private writes = new Map<string, number>();
  private reads = new Map<string, Promise<void>>();
  constructor(private home: string) {}
  private path(session: string) {
    return join(
      this.home,
      "plans",
      createHash("sha256").update(session).digest("hex") + ".json",
    );
  }
  async load(session: string, refresh = false) {
    if (!refresh && this.states.has(session)) return;
    // Serialize refreshes; a later read must not be replaced by an older response.
    while (this.reads.has(session))
      await this.reads.get(session)!.catch(() => {});
    const work = this.readState(session);
    this.reads.set(session, work);
    try {
      await work;
    } finally {
      if (this.reads.get(session) === work) this.reads.delete(session);
    }
  }
  private async readState(session: string) {
    const generation = this.writes.get(session) ?? 0;
    try {
      const raw = JSON.parse(await readFile(this.path(session), "utf8"));
      if (generation !== (this.writes.get(session) ?? 0)) return;
      const state = stateSchema.parse(raw);
      state.incomplete ||= !Object.hasOwn(raw, "versions");
      this.states.set(session, state);
    } catch (error) {
      if (generation !== (this.writes.get(session) ?? 0)) return;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.states.set(session, {
        active: false,
        versions: [],
        incomplete: false,
      });
    }
  }
  get(session: string) {
    const value = this.states.get(session);
    if (!value) throw Error("Planning state not loaded");
    return structuredClone({
      active: value.active,
      ...(value.plan ? { plan: value.plan } : {}),
    });
  }
  progress(session: string): PlanProgress | null {
    const value = this.states.get(session);
    if (!value) throw Error("Planning state not loaded");
    const { plan, progress } = value;
    if (value.active || !plan || progress?.planId !== plan.id) return null;
    return {
      planId: plan.id,
      title: plan.title,
      steps: plan.steps.map((text, index) => ({
        text,
        ...structuredClone(progress.steps[index]!),
      })),
    };
  }
  async updateStep(session: string, update: z.infer<typeof stepUpdateSchema>) {
    const { planId, step, status, note } = stepUpdateSchema.parse(update);
    const state = this.states.get(session);
    if (!state) throw Error("Planning state not loaded");
    if (state.active || !state.plan || state.progress?.planId !== state.plan.id)
      throw Error("No approved plan is executing in this session");
    if (state.plan.id !== planId)
      throw Error("Plan changed; report progress for the approved plan only");
    if (step > state.plan.steps.length)
      throw Error(
        `Plan has ${state.plan.steps.length} steps; step ${step} does not exist`,
      );
    const steps = structuredClone(state.progress.steps);
    steps[step - 1] = { status, ...(note ? { note } : {}) };
    await this.save(session, { ...state, progress: { planId, steps } });
    return this.progress(session)!;
  }
  async removeSession(session: string) {
    this.writes.set(session, (this.writes.get(session) ?? 0) + 1);
    this.states.delete(session);
    await rm(this.path(session), { force: true });
    await rm(this.path(session) + ".versions", {
      recursive: true,
      force: true,
    });
    this.writes.set(session, (this.writes.get(session) ?? 0) + 1);
    this.states.delete(session);
  }
  private async save(session: string, state: z.infer<typeof stateSchema>) {
    const path = this.path(session),
      temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(this.home, "plans"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      await rename(temp, path);
      this.writes.set(session, (this.writes.get(session) ?? 0) + 1);
      this.states.set(session, state);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async archive(session: string, plan: Plan) {
    const directory = this.path(session) + ".versions";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, plan.id + ".json");
    const temp = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const saved = planSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (JSON.stringify(saved) !== JSON.stringify(plan))
        throw Error(
          "Saved plan version does not match; history was not overwritten",
        );
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async preserve(session: string) {
    const state = structuredClone(this.states.get(session)!);
    if (!state) throw Error("Planning state not loaded");
    if (state.plan && !state.versions.includes(state.plan.id)) {
      await this.archive(session, state.plan);
      state.versions.push(state.plan.id);
      state.incomplete = true;
    }
    return state;
  }
  private versionIds(session: string) {
    const state = this.states.get(session);
    if (!state) throw Error("Planning state not loaded");
    return state.plan && !state.versions.includes(state.plan.id)
      ? [...state.versions, state.plan.id]
      : state.versions;
  }
  async history(session: string, before?: number): Promise<PlanHistory> {
    const ids = this.versionIds(session);
    const end =
      before === undefined
        ? ids.length
        : Math.min(
            ids.length,
            z.number().int().min(1).safe().parse(before) - 1,
          );
    const start = Math.max(0, end - 20);
    const items = [];
    for (let index = end - 1; index >= start; index--) {
      const plan = await this.version(session, ids[index]!);
      items.push({ id: plan.id, title: plan.title, revision: index + 1 });
    }
    const state = this.states.get(session)!;
    return {
      items,
      nextBefore: start ? start + 1 : null,
      incomplete: state.incomplete || ids.length > state.versions.length,
    };
  }
  async version(session: string, id: string): Promise<Plan> {
    z.string().uuid().parse(id);
    if (!this.versionIds(session).includes(id))
      throw Error("Plan version not found in this session");
    const state = this.states.get(session)!;
    if (!state.versions.includes(id) && state.plan?.id === id)
      return structuredClone(state.plan);
    const plan = planSchema.parse(
      JSON.parse(
        await readFile(
          join(this.path(session) + ".versions", id + ".json"),
          "utf8",
        ),
      ),
    );
    if (plan.id !== id) throw Error("Plan version identity does not match");
    return plan;
  }
  async setActive(session: string, active: boolean) {
    const state = await this.preserve(session);
    await this.save(session, {
      ...state,
      active,
      plan: undefined,
      progress: undefined,
    });
  }
  async propose(session: string, proposal: z.infer<typeof proposalSchema>) {
    if (!this.get(session).active)
      throw Error("Enter Plan mode before proposing a plan");
    const state = await this.preserve(session);
    const plan = { ...proposalSchema.parse(proposal), id: randomUUID() };
    await this.archive(session, plan);
    await this.save(session, {
      ...state,
      active: true,
      plan,
      versions: [...state.versions, plan.id],
      progress: undefined,
    });
    return plan;
  }
  async approve(session: string, id: string) {
    const state = this.get(session);
    if (!state.active || state.plan?.id !== id)
      throw Error("Plan changed; review the current version before executing");
    const saved = await this.preserve(session);
    await this.save(session, {
      ...saved,
      active: false,
      plan: state.plan,
      progress: {
        planId: id,
        steps: state.plan.steps.map(() => ({ status: "pending" as const })),
      },
    });
    return state.plan;
  }
}
export { planText, planExecutionPrompt } from "./plan-text.ts";
