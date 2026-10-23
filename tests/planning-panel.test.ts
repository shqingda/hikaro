import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import {
  askQuestions,
  answerQuestion,
  reviewPlan,
} from "../packages/tui/src/planning.ts";
import { QuestionDraftSaver } from "../packages/tui/src/question-drafts.ts";
import type { QuestionDraft } from "../packages/protocol/src/contracts.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
function fixture() {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  return {
    abort,
    panel,
    view: {
      openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
      notice: vi.fn(),
    } as unknown as HikaroView,
    wait: async (text: string) =>
      vi.waitFor(() =>
        expect(
          stripVTControlCharacters(panel.render(100).join("\n")).replace(
            /\x1b_pi:[^\x07]*\x07/g,
            "",
          ),
        ).toContain(text),
      ),
  };
}
it("reports only opted-in non-secret prompt edits, including text not submitted", async () => {
  const { panel, wait } = fixture();
  const changed = vi.fn();
  const prompt = panel.prompt("Draft answer", false, "saved", {
    cancelValue: "",
    onChange: changed,
  });
  await wait("Draft answer");
  expect(changed).not.toHaveBeenCalled();
  panel.handleInput("\x05");
  panel.handleInput(" 中文🌅");
  expect(changed).toHaveBeenLastCalledWith("saved 中文🌅");
  panel.handleInput("\r");
  expect(await prompt).toBe("saved 中文🌅");
  expect(changed).toHaveBeenCalledTimes(1);
  const secret = panel.prompt("Credential", true, "", {
    cancelValue: "",
    onChange: changed,
  });
  panel.handleInput("never store this");
  panel.cancelStep();
  expect(await secret).toBe("");
  expect(changed).toHaveBeenCalledTimes(1);
  const ordinary = panel.prompt("Other input", false, "", { cancelValue: "" });
  panel.handleInput("unrelated");
  panel.cancelStep();
  await ordinary;
  expect(changed).toHaveBeenCalledTimes(1);
});
it("restores unsubmitted input and selected answers, preserves back edits, and submits only after review", async () => {
  const { view, panel, wait } = fixture();
  const initial: QuestionDraft = {
    answers: { color: "Red" },
    inputs: { name: "待确认  🌅" },
    position: { kind: "input", questionId: "name" },
  };
  let revision = 4;
  const save = vi.fn(async () => ({ revision: ++revision }));
  const draft = new QuestionDraftSaver(
    { revision, draft: initial },
    save,
    vi.fn(),
  );
  const submit = vi.fn(async () => ({ completed: true, recovered: true }));
  const work = answerQuestion(
    view,
    {
      recovered: true,
      questions: [
        { id: "color", question: "Which color?", options: ["Red", "Blue"] },
        { id: "name", question: "What name?" },
      ],
    },
    new AbortController().signal,
    submit,
    draft,
  );
  await wait("Your answer");
  await wait("待确认  🌅");
  expect(submit).not.toHaveBeenCalled();
  panel.cancelStep();
  await wait("Recovered question 2/2");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Your answer");
  panel.handleInput("\x05");
  panel.handleInput(" 42");
  panel.handleInput("\r");
  await wait("Review answers");
  await wait("Red");
  await wait("待确认  🌅 42");
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Recovered question 1/2");
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Recovered question 2/2");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Your answer");
  await wait("待确认  🌅 42");
  panel.handleInput("\r");
  await wait("Review answers");
  await wait("Blue");
  expect(submit).not.toHaveBeenCalled();
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await work;
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    { color: "Blue", name: "待确认  🌅 42" },
    revision,
  );
  expect(save).toHaveBeenLastCalledWith(expect.any(Number), {
    answers: { color: "Blue", name: "待确认  🌅 42" },
    inputs: { name: "待确认  🌅 42" },
    position: { kind: "review" },
  });
});
it("does not submit answers when a different panel saved a newer draft", async () => {
  const { view, panel, wait } = fixture();
  const initial: QuestionDraft = {
    answers: { q: "mine" },
    inputs: {},
    position: { kind: "review" },
  };
  const draft = new QuestionDraftSaver(
    { revision: 1, draft: initial },
    async () => ({
      conflict: true,
      current: { revision: 2, draft: { ...initial, answers: { q: "theirs" } } },
    }),
    vi.fn(),
  );
  draft.update(initial);
  const submit = vi.fn();
  const work = answerQuestion(
    view,
    { questions: [{ id: "q", question: "Which?" }] },
    new AbortController().signal,
    submit,
    draft,
  );
  await wait("Review answers");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Answers not saved");
  await wait("another view");
  expect(submit).not.toHaveBeenCalled();
  panel.cancelStep();
  await work;
});
it("collects a choice and custom answer, then requires explicit submission", async () => {
  const { view, panel, wait } = fixture();
  const work = askQuestions(
    view,
    [
      { id: "color", question: "Which color?", options: ["Red", "Blue"] },
      { id: "name", question: "What name?" },
    ],
    new AbortController().signal,
  );
  await wait("Which color?");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("What name?");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await wait("Your answer");
  panel.handleInput("Hikaro");
  panel.handleInput("\r");
  await wait("Review answers");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  expect(await work).toEqual({ color: "Red", name: "Hikaro" });
});
it("cancels questions without fabricating answers and leaves a reviewed plan unapproved on Escape", async () => {
  const { view, panel, wait } = fixture();
  const answers = askQuestions(
    view,
    [{ id: "q", question: "Choose?", options: ["A", "B"] }],
    new AbortController().signal,
  );
  await wait("Choose?");
  panel.cancelStep();
  expect(await answers).toBeUndefined();
  const review = reviewPlan(view, {
    id: "version",
    title: "Change",
    steps: ["Edit file"],
    validation: "Test",
  });
  await wait("Plan review");
  panel.cancelStep();
  expect(await review).toEqual({ action: "keep" });
});
