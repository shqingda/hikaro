import { visibleWidth } from "./primitives.ts";
import { muted } from "./theme.ts";

/** Shared bounds for task-focused menus, readers and permission review. */
export function surfaceBounds(width: number) {
  const content = Math.max(1, Math.min(76, width - 4));
  return { content, left: Math.max(0, Math.floor((width - content - 2) / 2)) };
}
export function renderSurface(lines: string[], width: number) {
  const { content, left } = surfaceBounds(width);
  const pad = " ".repeat(left);
  return [
    pad + muted("╭" + "─".repeat(content) + "╮"),
    ...lines.map(
      (line) =>
        pad +
        muted("│") +
        line +
        " ".repeat(Math.max(0, content - visibleWidth(line))) +
        muted("│"),
    ),
    pad + muted("╰" + "─".repeat(content) + "╯"),
  ];
}
