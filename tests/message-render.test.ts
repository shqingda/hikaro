import { expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { MessageComponent } from "../packages/tui/src/index.ts";

const plain = (lines: string[]) =>
  lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

it("reuses unchanged user rows and recolours them after text, width or theme changes", () => {
  const original = MessageComponent.userBackground;
  const message = new MessageComponent(1, "user", "**Hello** `there`");
  try {
    const first = message.render(60);
    expect(message.render(60)).toBe(first);
    expect(first.every((line) => line.startsWith(original))).toBe(true);

    expect(message.render(40)).not.toBe(first);
    message.setText("Changed");
    expect(plain(message.render(40))).toContain("Changed");

    const before = message.render(40);
    MessageComponent.userBackground = "\x1b[48;2;1;2;3m";
    const recoloured = message.render(40);
    expect(recoloured).not.toBe(before);
    expect(recoloured[0]!.startsWith("\x1b[48;2;1;2;3m")).toBe(true);

    message.invalidate();
    expect(message.render(40)).not.toBe(recoloured);
  } finally {
    MessageComponent.userBackground = original;
  }
});

const blocks = [
  "## 中文 heading",
  "**Bold** and `code`, emoji 🙂.",
  "Para line one\nlazy line two",
  "- item\n- item two",
  "1. one\n2. two",
  "- loose\n\n- list",
  "  indented continuation",
  "    indented code",
  "```js\nconst a = 1;\n\nconst b = 2;\n```",
  "~~~\n```\nnot closed by backticks\n\n~~~",
  "> quote\n> more",
  ">",
  "> \n\n>",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "---",
  "Setext\n===",
  "x\nHKB1_2X",
];

it("renders every streaming prefix byte-for-byte like the final message", () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let doc = 0; doc < 300; doc++) {
    const text = Array.from(
      { length: 4 + random(6) },
      () => blocks[random(blocks.length)],
    ).join(random(4) ? "\n\n" : "\n\n\n");
    const live = new MessageComponent(1, "assistant", "", true);
    for (let end = 1; end <= text.length; end += 1 + random(5)) {
      const part = text.slice(0, end);
      live.setText(part);
      const width = 40 + random(40);
      expect(live.render(width)).toEqual(
        new MessageComponent(1, "assistant", part).render(width),
      );
    }
  }
});

it("keeps the parsed prefix while only the live tail grows", async () => {
  const { stableMarkdownBoundary } =
    await import("../packages/tui/src/index.ts");
  const head = "## Title\n\n- a\n- b\n\n";
  expect(stableMarkdownBoundary(head + "tail")).toBe(0);
  expect(stableMarkdownBoundary(head + "tail\n")).toBe(head.length);
  expect(stableMarkdownBoundary(head + "- c")).toBe(0);
  expect(stableMarkdownBoundary("```\na\n\nb")).toBe(0);
  expect(stableMarkdownBoundary("a\n\nb\n\n[x]: http://e")).toBe(0);
  expect(stableMarkdownBoundary("a\n\n\n\nb\n")).toBe("a\n\n\n\n".length);
});
