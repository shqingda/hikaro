import { planText } from "../../runtime/src/plan-text.ts";
import type { Plan, Questions } from "../../runtime/src/planning.ts";
import type { HikaroView } from "./index.ts";
export async function askQuestions(
  view: HikaroView,
  questions: Questions,
  runSignal: AbortSignal,
  recovered = false,
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
        `${recovered ? "Recovered question" : "Question"} ${index + 1}/${questions.length}`,
        (recovered
          ? "Previous execution interrupted. Answers will be saved to this session; send a new message to continue. No previous operation will run automatically.\n\n"
          : "") + q.question,
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
/** A detached panel preserves the pending question; only an explicit answer or dismissal settles it. */
export async function answerQuestion(
  view: HikaroView,
  question: { questions: Questions; recovered?: boolean },
  signal: AbortSignal,
  submit: (answers: Record<string, string> | undefined) => Promise<unknown>,
) {
  const answers = await askQuestions(
    view,
    question.questions,
    signal,
    question.recovered,
  );
  while (!signal.aborted) {
    try {
      const result = await submit(answers);
      if (signal.aborted) return;
      const recovered =
        question.recovered ||
        (result &&
          typeof result === "object" &&
          "recovered" in result &&
          result.recovered === true);
      if (recovered)
        view.notice(
          answers
            ? "Recovered answers saved. Send a new message to continue; no operation was resumed."
            : "Recovered questions dismissed. No answers were inferred.",
        );
      return;
    } catch (error) {
      if (signal.aborted) return;
      const { panel, signal: panelSignal, close } = view.openModelPanel();
      signal.addEventListener("abort", close, { once: true });
      try {
        const choice = await panel.readDocument(
          "Answers not saved",
          `${String(error)}\n\nYour answers are retained here.${question.recovered ? " A previous execution lease can take up to 30 seconds to expire. Retry when the session is idle." : " Retry saving when ready."}`,
          [{ value: "retry", label: "Retry saving answers" }],
        );
        if (choice.value !== "retry") return;
      } catch (error) {
        if (!signal.aborted && !panelSignal.aborted) throw error;
        return;
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    }
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

/** History is inspection only; approval always belongs to the current plan. */
export async function browsePlanHistory(
  view: HikaroView,
  source: {
    list(
      before?: number,
    ): Promise<import("../../runtime/src/planning.ts").PlanHistory>;
    detail(id: string): Promise<Plan>;
  },
) {
  const { panel, signal, close } = view.openModelPanel();
  const cursors: Array<number | undefined> = [undefined];
  let page = 0;
  try {
    for (;;) {
      panel.progress("Loading plan history…");
      const history = await source.list(cursors[page]);
      signal.throwIfAborted();
      const choice = await panel.choose(
        `Plan history · page ${page + 1}`,
        [
          ...history.items.map((item) => ({
            value: item.id,
            label: `Version ${item.revision} · ${item.title}`,
          })),
          ...(page ? [{ value: "previous", label: "Newer versions" }] : []),
          ...(history.nextBefore !== null
            ? [{ value: "next", label: "Older versions" }]
            : []),
          { value: "close", label: "Close history" },
        ],
        history.incomplete
          ? "Read-only. Earlier versions were not retained by the previous version of Hikaro."
          : history.items.length
            ? "Read-only. Use /plan to review and approve the current plan."
            : "No saved plans in this session.",
        undefined,
        { search: false, cancelValue: "close", enterAction: "read" },
      );
      if (choice.value === "close") return;
      if (choice.value === "previous") {
        page--;
        continue;
      }
      if (choice.value === "next") {
        cursors[++page] = history.nextBefore!;
        continue;
      }
      const entry = history.items.find((item) => item.id === choice.value);
      if (!entry) continue;
      panel.progress("Loading saved plan…");
      const plan = await source.detail(entry.id);
      signal.throwIfAborted();
      if (plan.id !== entry.id)
        throw Error("Plan version identity does not match");
      await panel.readDocument(
        `Plan version ${entry.revision} · read-only`,
        planText(plan),
        [],
      );
    }
  } catch (error) {
    if (!signal.aborted) view.setError(String(error));
  } finally {
    close();
  }
}
