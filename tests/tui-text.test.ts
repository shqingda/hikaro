import { expect, it } from "vitest";
import { sanitize } from "../packages/tui/src/text.ts";
import { sanitize as publicSanitize } from "../packages/tui/src/index.ts";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";

it("exports the same terminal sanitizer", () => {
  expect(publicSanitize).toBe(sanitize);
});

it.each([
  ["", ""],
  ["中文 🙂\n\tsecond line", "中文 🙂\n\tsecond line"],
  ["\x1b[31mRed\x1b[0m\x1b[2J", "Red"],
  ["\x1b]0;Window title\x07Visible", "Visible"],
  ["A\x00\x08\x0b\x0c\r\x7f\x80\x9fB", "AB"],
])("sanitizes terminal text %j", (input, expected) => {
  expect(sanitize(input)).toBe(expected);
});

it("cleans picker labels and descriptions while preserving selection IDs", async () => {
  const panel = new ModelPanel(new AbortController().signal, () => {});
  const value = "opaque\x00id";
  const choice = panel.choose("Models", [
    {
      value,
      label: "\x1b[31m模型\x1b[0m\x07",
      description: "\x1b]0;Injected title\x07Description\x00",
    },
  ]);
  const rendered = sanitize(panel.render(80).join("\n"));
  expect(rendered).toContain("模型");
  expect(rendered).toContain("Description");
  expect(rendered).not.toContain("Injected title");
  panel.handleInput("\r");
  expect(await choice).toEqual({ value, makeDefault: false });
});
