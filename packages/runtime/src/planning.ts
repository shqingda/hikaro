import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
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
const stateSchema = z.object({
  active: z.boolean(),
  plan: planSchema.optional(),
});
export type Plan = z.infer<typeof planSchema>;
export class Planning {
  private states = new Map<string, z.infer<typeof stateSchema>>();
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
    try {
      this.states.set(
        session,
        stateSchema.parse(
          JSON.parse(await readFile(this.path(session), "utf8")),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.states.set(session, { active: false });
    }
  }
  get(session: string) {
    const value = this.states.get(session);
    if (!value) throw Error("Planning state not loaded");
    return structuredClone(value);
  }
  async removeSession(session: string) {
    this.states.delete(session);
    await rm(this.path(session), { force: true });
  }
  private async save(session: string, state: z.infer<typeof stateSchema>) {
    const path = this.path(session),
      temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(this.home, "plans"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      await rename(temp, path);
      this.states.set(session, state);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async setActive(session: string, active: boolean) {
    await this.save(session, { active });
  }
  async propose(session: string, proposal: z.infer<typeof proposalSchema>) {
    if (!this.get(session).active)
      throw Error("Enter Plan mode before proposing a plan");
    const plan = { ...proposalSchema.parse(proposal), id: randomUUID() };
    await this.save(session, { active: true, plan });
    return plan;
  }
  async approve(session: string, id: string) {
    const state = this.get(session);
    if (!state.active || state.plan?.id !== id)
      throw Error("Plan changed; review the current version before executing");
    await this.save(session, { active: false, plan: state.plan });
    return state.plan;
  }
}
export { planText } from "./plan-text.ts";
