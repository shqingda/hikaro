import type { PlanProgress } from "./planning.ts";
import type { ChangeReview } from "./change-review.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";
import {
  toolEvidenceSchema,
  type StepEvidence,
} from "../../core/src/change-evidence.ts";

export async function planEvidence(
  root: string,
  progress: PlanProgress,
  review: ChangeReview,
  store: SQLiteStore,
): Promise<PlanProgress> {
  const empty = (): StepEvidence => ({ reliable: 0, observed: 0, tools: [] });
  const steps = progress.steps.map((step) => ({ ...step, evidence: empty() })),
    unassigned = empty();
  const target = (step?: number) =>
    step === undefined ? unassigned : (steps[step - 1]?.evidence ?? unassigned);
  const changes = await review.list(root);
  for (const change of changes.items) {
    const ref = change.state === "observed" ? change.plan : change.origin?.plan;
    if (ref?.sessionId !== root || ref.planId !== progress.planId) continue;
    target(ref.step)[change.state === "observed" ? "observed" : "reliable"]++;
  }
  let count = 0,
    incomplete = changes.warnings.length > 0;
  for (const sessionId of (await review.owners(root)).keys()) {
    const page = await store.planEvidence(sessionId, root, progress.planId);
    incomplete ||= page.more;
    for (const raw of page.items) {
      if (count >= 60) {
        incomplete = true;
        break;
      }
      const evidence = toolEvidenceSchema.parse(raw);
      target(evidence.step).tools.push(evidence);
      count++;
    }
  }
  return { ...progress, steps, unassigned, evidenceIncomplete: incomplete };
}
