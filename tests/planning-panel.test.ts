import { expect, it, vi } from "vitest";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { askQuestions, reviewPlan } from "../packages/tui/src/planning.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";
function fixture() {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  return {
    abort,
    panel,
    view: {
      openModelPanel: () => ({ panel, signal: abort.signal, close: () => {} }),
    } as unknown as HikaroView,
    wait: async (text: string) =>
      vi.waitFor(() => expect(panel.render(100).join("\n")).toContain(text)),
  };
}
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
