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
