import type { Plan } from "./planning.ts";

export function planText(plan: Plan) {
  return `${plan.title}\n\n${plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n\n")}\n\nValidation\n${plan.validation}`;
}
