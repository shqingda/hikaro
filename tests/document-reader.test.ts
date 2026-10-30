import { expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";

it("searches the whole document, moves between hits, and never confirms an action while editing search", async () => {
  const panel = new ModelPanel(
    new AbortController().signal,
    () => {},
    () => 14,
  );
  const result = panel.readDocument(
    "Tool output",
    Array.from(
      { length: 70 },
      (_, index) =>
        `${index + 1}: ${index === 3 || index === 55 ? "needle 中文" : "ordinary output"}`,
    ).join("\n"),
    [{ value: "copy", label: "Copy this part" }],
  );
  let resolved = false;
  void result.then(() => {
    resolved = true;
  });
  const screen = () => stripVTControlCharacters(panel.render(60).join("\n"));
  screen();
  panel.handleInput("\x1b[B");
  panel.handleInput("/");
  panel.handleInput("needle 中文");
  expect(screen()).toContain("Match 1/2");
  panel.handleInput("\r");
  await Promise.resolve();
  expect(resolved).toBe(false);
  panel.handleInput("n");
  expect(screen()).toContain("56: needle 中文");
  expect(screen()).toContain("Match 2/2");
  panel.handleInput("N");
  expect(screen()).toContain("4: needle 中文");
  expect(screen()).toContain("Match 1/2");
  panel.handleInput("\r");
  expect((await result).value).toBe("copy");
});

it("finds a term across soft wraps and Escape cancels search before leaving the reader", async () => {
  const panel = new ModelPanel(
    new AbortController().signal,
    () => {},
    () => 13,
  );
  const result = panel.readDocument(
    "Result",
    `prefix ${"x".repeat(110)}needle ${"tail ".repeat(30)}`,
    false,
  );
  panel.render(40);
  panel.handleInput("\x06");
  panel.handleInput("xxxxneedle");
  const screen = () => stripVTControlCharacters(panel.render(40).join("\n"));
  expect(screen()).toContain("Match 1/1");
  expect(screen()).toContain("needle");
  expect(panel.cancelStep()).toBe(true);
  expect(screen()).not.toContain("Find in this part");
  panel.handleInput("/");
  panel.handleInput("\x01");
  panel.handleInput("\x0b");
  panel.handleInput("not-present");
  expect(screen()).toContain("No matches");
  panel.cancelStep();
  panel.cancelStep();
  expect((await result).value).toBe("back");
});

it("keeps a document action blocked when the terminal cannot display its contents", async () => {
  const panel = new ModelPanel(
    new AbortController().signal,
    () => {},
    () => 5,
  );
  const result = panel.readDocument("Diff", "private result", true);
  let resolved = false;
  void result.then(() => {
    resolved = true;
  });
  panel.render(40);
  panel.handleInput("\x1b[B");
  panel.handleInput("/");
  panel.handleInput("private");
  panel.render(40);
  panel.handleInput("\r");
  panel.handleInput("\r");
  await Promise.resolve();
  expect(resolved).toBe(false);
  panel.cancelStep();
  expect((await result).value).toBe("back");
});
