import { planText } from "../../runtime/src/plan-text.ts";
import type {
  Plan,
  PlanProgress,
  Questions,
} from "../../runtime/src/planning.ts";
import type { HikaroView } from "./index.ts";
import type { QuestionDraftSaver } from "./question-drafts.ts";
export async function askQuestions(
  view: HikaroView,
  questions: Questions,
  runSignal: AbortSignal,
  recovered = false,
  draft?: QuestionDraftSaver,
): Promise<Record<string, string> | undefined> {
  runSignal.throwIfAborted();
  const { panel, signal, close } = view.openModelPanel({
    interruptYielding: true,
  });
  runSignal.addEventListener("abort", close, { once: true });
  const answers: Record<string, string> = Object.assign(
    Object.create(null),
    draft?.initial?.answers,
  );
  const inputs: Record<string, string> = Object.assign(
    Object.create(null),
    draft?.initial?.inputs,
  );
  const position = draft?.initial?.position;
  let index =
    position?.kind === "review"
      ? questions.length
      : position
        ? questions.findIndex((q) => q.id === position.questionId)
        : 0;
  let writingInput = position?.kind === "input";
  const save = () =>
    draft?.update({
      answers,
      inputs,
      position:
        index === questions.length
          ? { kind: "review" }
          : {
              kind: writingInput ? "input" : "question",
              questionId: questions[index]!.id,
            },
    });
  try {
    if (index < 0)
      throw Error("Saved answer draft does not match this question");
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
        save();
        continue;
      }
      const q = questions[index]!;
      const choice = writingInput
        ? { value: "custom" }
        : await panel.readDocument(
            `${recovered ? "Recovered question" : "Question"} ${index + 1}/${questions.length}`,
            (recovered
              ? "Previous execution interrupted. Answers will be saved to this session; send a new message to continue. No previous operation will run automatically.\n\n"
              : "") + q.question,
            [
              ...(q.options ?? []).map((label, i) => ({
                value: String(i),
                label,
              })),
              { value: "custom", label: "Write my answer…" },
            ],
          );
      if (choice.value === "back") {
        if (!index) return;
        index--;
        save();
        continue;
      }
      if (choice.value === "custom") {
        writingInput = true;
        save();
        const text = await panel.prompt(
          "Your answer",
          false,
          inputs[q.id] ?? answers[q.id] ?? "",
          {
            cancelValue: "",
            onChange: (value) => {
              inputs[q.id] = value;
              save();
            },
          },
        );
        writingInput = false;
        if (!text.trim()) {
          save();
          continue;
        }
        answers[q.id] = text;
        inputs[q.id] = text;
      } else answers[q.id] = q.options![Number(choice.value)]!;
      index++;
      save();
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
  submit: (
    answers: Record<string, string> | undefined,
    draftRevision?: number,
  ) => Promise<unknown>,
  draft?: QuestionDraftSaver,
) {
  try {
    if (draft?.initial)
      view.notice(
        question.recovered
          ? "Saved answer draft restored. Previous execution interrupted; review and submit to save context only. No operation resumes automatically."
          : "Saved answer draft restored. Review and submit explicitly to continue.",
      );
    const answers = await askQuestions(
      view,
      question.questions,
      signal,
      question.recovered,
      draft,
    );
    while (!signal.aborted) {
      try {
        await draft?.flush();
        signal.throwIfAborted();
        const result = await submit(answers, draft?.revision);
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
  } finally {
    draft?.stop();
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

const stepMarks = {
  pending: "○ Pending",
  in_progress: "◐ In progress",
  completed: "✓ Completed",
  blocked: "! Blocked",
  skipped: "– Skipped",
} as const;

export function planProgressText(progress: PlanProgress) {
  const done = progress.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const edits =
    progress.recordedEdits === undefined
      ? ""
      : `\n${progress.recordedEdits} file edits recorded since approval (see /changes)`;
  return `${progress.title}\n${done}/${progress.steps.length} steps reported completed${edits}\n\n${progress.steps
    .map(
      (step, index) =>
        `${index + 1}. ${stepMarks[step.status]} · ${step.text}${step.note ? `\n   ${step.note}` : ""}${step.evidence ? `\n   Evidence: ${step.evidence.reliable} reliable edits, ${step.evidence.observed} observed differences, ${step.evidence.tools.length} tool results` : ""}`,
    )
    .join(
      "\n\n",
    )}${progress.unassigned ? `\n\nUnassigned: ${progress.unassigned.reliable} reliable edits, ${progress.unassigned.observed} observed differences, ${progress.unassigned.tools.length} tool results` : ""}${progress.evidenceIncomplete ? "\nEvidence listing is incomplete; inspect /changes and session history." : ""}\n\nStatus is reported by the model while executing; check /changes and tests for actual results.`;
}

/** Read-only progress of the approved plan; refreshing never resumes execution. */
export async function browsePlanProgress(
  view: HikaroView,
  read: () => Promise<PlanProgress | null>,
  evidence?: {
    changes(planId: string, step: number): Promise<void>;
    tool(
      planId: string,
      tool: import("../../core/src/change-evidence.ts").ToolEvidence,
    ): Promise<string>;
  },
) {
  const { panel, signal, close } = view.openModelPanel();
  try {
    for (;;) {
      panel.progress("Loading plan progress…");
      const progress = await read();
      signal.throwIfAborted();
      if (!progress) {
        view.notice(
          "No approved plan in this session. Use /plan to review and approve one.",
        );
        return;
      }
      const choice = await panel.readDocument(
        "Plan progress · reported by the model",
        planProgressText(progress),
        [
          { value: "refresh", label: "Refresh" },
          ...(evidence && progress.unassigned
            ? [{ value: "evidence", label: "Inspect execution evidence…" }]
            : []),
        ],
      );
      if (choice.value === "evidence" && evidence) {
        const selection = await panel.choose(
          "Evidence by step",
          [
            ...progress.steps.map((step, index) => ({
              value: String(index + 1),
              label: `${index + 1}. ${step.text}`,
            })),
            { value: "0", label: "Unassigned" },
          ],
          "Model reports and execution evidence are distinct. Zero edits alone do not mean failure.",
          undefined,
          { search: false },
        );
        const step = Number(selection.value);
        const proof = step
          ? progress.steps[step - 1]?.evidence
          : progress.unassigned;
        if (!proof) continue;
        const action = await panel.readDocument(
          "Execution evidence",
          evidenceText(proof),
          [
            { value: "changes", label: "Inspect file differences…" },
            ...proof.tools
              .filter((t) => t.status !== "unknown")
              .map((tool) => ({
                value: String(tool.seq),
                label: `${tool.name} · ${tool.status} · ${tool.sessionId.slice(0, 8)}`,
              })),
          ],
        );
        if (action.value === "changes") {
          close();
          await evidence.changes(progress.planId, step);
          return;
        }
        const tool = proof.tools.find((t) => String(t.seq) === action.value);
        if (tool) {
          panel.progress("Loading tool result…");
          const text = await evidence.tool(progress.planId, tool);
          signal.throwIfAborted();
          await panel.readDocument(`${tool.name} · ${tool.status}`, text, []);
        }
        continue;
      }
      if (choice.value !== "refresh") return;
    }
  } catch (error) {
    if (!signal.aborted) view.setError(String(error));
  } finally {
    close();
  }
}

function evidenceText(
  evidence: import("../../core/src/change-evidence.ts").StepEvidence,
) {
  return (
    `${evidence.reliable} reliable edits · ${evidence.observed} observed differences · ${evidence.tools.length} tool results\n\n` +
    evidence.tools
      .map(
        (tool) =>
          `${tool.name} · ${tool.status}\nTask ${tool.sessionId} · call ${tool.callId}${tool.runId ? ` · run ${tool.runId}` : ""}\n${tool.preview}`,
      )
      .join("\n\n")
  );
}
