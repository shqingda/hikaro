import { expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { changeDiff } from "../packages/tui/src/change-review.ts";

it("blocks confirmation until the complete path and consequences fit", async () => {
  let rows = 5;
  const panel = new ModelPanel(
    new AbortController().signal,
    () => {},
    () => rows,
  );
  let resolved = false;
  const choice = panel
    .choose(
      "Confirm",
      [{ value: "confirm", label: "Restore" }],
      "/project/long/path/file.txt\nRestores previous contents; later edits are preserved.",
      undefined,
      { search: false, requireNoticeVisible: true },
    )
    .then((v) => {
      resolved = true;
      return v;
    });
  expect(panel.render(20).join("\n")).toContain("Resize");
  panel.handleInput("\r");
  await Promise.resolve();
  expect(resolved).toBe(false);
  rows = 20;
  expect(panel.render(100).join("\n")).toContain("/project/long/path/file.txt");
  panel.handleInput("\r");
  expect((await choice).value).toBe("confirm");
});

it("paginates the whole diff, strips terminal controls, and returns with Escape", async () => {
  const panel = new ModelPanel(new AbortController().signal, () => {});
  const choice = panel.readDocument(
    "Diff",
    "\x1b[2J" + Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n"),
    true,
  );
  const screen = () => stripVTControlCharacters(panel.render(100).join("\n"));
  expect(screen()).toContain("line-0");
  expect(screen()).not.toContain("line-79");
  panel.handleInput("\x1b[F");
  expect(screen()).toContain("line-79");
  expect(panel.cancelStep()).toBe(true);
  expect((await choice).value).toBe("back");
});

it("makes empty files and final-newline-only edits distinguishable", () => {
  expect(changeDiff("a", undefined, "hello\n")).toContain(
    "@@ -0,0 +1,1 @@\n+hello",
  );
  expect(changeDiff("a", "hello", "hello\n")).toContain(
    "-hello\n\\ No newline at end of file\n+hello",
  );
  expect(changeDiff("a", "hello\n", "")).toContain("@@ -1,1 +0,0 @@\n-hello");
});
