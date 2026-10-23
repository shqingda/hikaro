import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { browsePlanHistory } from "../packages/tui/src/planning.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

function fixture() {
  const controller = new AbortController();
  const panel = new ModelPanel(controller.signal, () => {});
  const close = vi.fn();
  const setError = vi.fn();
  const view = {
    openModelPanel: () => ({ panel, signal: controller.signal, close }),
    setError,
  } as unknown as HikaroView;
  const screen = () => stripVTControlCharacters(panel.render(100).join("\n"));
  const wait = (text: string) =>
    vi.waitFor(() => expect(screen()).toContain(text));
  return { controller, panel, close, setError, view, screen, wait };
}

it("reads prior plans with an explicit legacy-history limit and no execution action", async () => {
  const f = fixture();
  const plan = {
    id: "saved",
    title: "Original title",
    steps: ["Original step"],
    validation: "Original check",
  };
  const list = vi.fn(async () => ({
    items: [{ id: plan.id, title: plan.title, revision: 1 }],
    nextBefore: null,
    incomplete: true,
  }));
  const detail = vi.fn(async () => plan);
  const work = browsePlanHistory(f.view, { list, detail });
  await f.wait("Earlier versions were not retained");
  f.panel.handleInput("\r");
  await f.wait("Plan version 1 · read-only");
  expect(f.screen()).toContain("Original step");
  expect(f.screen()).toContain("Original check");
  expect(f.screen()).not.toMatch(/Approve|Execute|Roll back/);
  expect(f.screen()).toContain("Back to list");
  f.panel.cancelStep();
  await f.wait("Plan history · page 1");
  f.panel.cancelStep();
  await work;
  expect(detail).toHaveBeenCalledExactlyOnceWith("saved");
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("discards a late plan-list response after cancellation", async () => {
  const f = fixture();
  let resolve!: (value: {
    items: [];
    nextBefore: null;
    incomplete: false;
  }) => void;
  const work = browsePlanHistory(f.view, {
    list: () =>
      new Promise((done) => {
        resolve = done;
      }),
    detail: async () => {
      throw Error("Must not load a cancelled selection");
    },
  });
  expect(f.screen()).toContain("Loading plan history");
  f.controller.abort();
  resolve({ items: [], nextBefore: null, incomplete: false });
  await work;
  expect(f.setError).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
});
