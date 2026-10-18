import {
  planText,
  type Plan,
  type Questions,
} from "../../runtime/src/planning.ts";
import type { HikaroView } from "./index.ts";
export async function askQuestions(
  view: HikaroView,
  questions: Questions,
  runSignal: AbortSignal,
): Promise<Record<string, string> | undefined> {
  runSignal.throwIfAborted();
  const { panel, signal, close } = view.openModelPanel({
    interruptYielding: true,
  });
  runSignal.addEventListener("abort", close, { once: true });
  const answers: Record<string, string> = Object.create(null);
  let index = 0;
  try {
    for (;;) {
      if (index === questions.length) {
        const choice = await panel.readDocument(
          "Review answers",
          questions.map((q) => `${q.question}\n${answers[q.id]}`).join("\n\n"),
          [
            { value: "submit", label: "Submit answers" },
            { value: "revise", label: "Revise answers" },
          ],
        );
        if (choice.value === "submit") return answers;
        index = choice.value === "revise" ? 0 : questions.length - 1;
        continue;
      }
      const q = questions[index]!;
      const choice = await panel.readDocument(
        `Question ${index + 1}/${questions.length}`,
        q.question,
        [
          ...(q.options ?? []).map((label, i) => ({ value: String(i), label })),
          { value: "custom", label: "Write my answer…" },
        ],
      );
      if (choice.value === "back") {
        if (!index) return;
        index--;
        continue;
      }
      if (choice.value === "custom") {
        const text = await panel.prompt(
          "Your answer",
          false,
          answers[q.id] ?? "",
          { cancelValue: "" },
        );
        if (!text.trim()) continue;
        answers[q.id] = text;
      } else answers[q.id] = q.options![Number(choice.value)]!;
      index++;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    return;
  } finally {
    runSignal.removeEventListener("abort", close);
    close();
  }
}
export async function reviewPlan(
  view: HikaroView,
  plan: Plan,
): Promise<
  | { action: "keep" }
  | { action: "revise"; text: string }
  | { action: "execute"; id: string }
> {
  const { panel, signal, close } = view.openModelPanel({
    interruptYielding: true,
  });
  try {
    for (;;) {
      const choice = await panel.readDocument(
        "Plan review · read-only",
        planText(plan),
        [
          { value: "execute", label: "Approve and execute…" },
          { value: "revise", label: "Request changes…" },
        ],
      );
      if (choice.value === "back") return { action: "keep" };
      if (choice.value === "revise") {
        const text = await panel.prompt("Changes to the plan", false, "", {
          cancelValue: "",
        });
        if (text.trim()) return { action: "revise", text };
        continue;
      }
      const confirm = await panel.choose(
        "Confirm plan execution",
        [
          { value: "keep", label: "Keep read-only" },
          { value: "execute", label: "Execute reviewed plan" },
        ],
        `${plan.title}\nThis enables editing and execution under your current permission mode.`,
        undefined,
        { search: false, cancelValue: "keep", requireNoticeVisible: true },
      );
      if (confirm.value === "execute")
        return { action: "execute", id: plan.id };
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    return { action: "keep" };
  } finally {
    close();
  }
}
