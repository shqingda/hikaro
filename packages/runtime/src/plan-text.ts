import type { Plan } from "./planning.ts";

export function planText(plan: Plan) {
  return `${plan.title}\n\n${plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n\n")}\n\nValidation\n${plan.validation}`;
}

/** The execution request sent after approval; both TUIs share this wording. */
export function planExecutionPrompt(plan: Plan) {
  return `The user reviewed and approved plan ${plan.id}. Execute this plan and verify the result. Before and after each step, call update_plan_step with plan_id ${plan.id}, the 1-based step number and its status (in_progress, completed, blocked or skipped).\n${planText(plan)}`;
}
