import type { Markdown } from "@earendil-works/pi-tui/dist/components/markdown.js";

export function createMarkdown(
  ...args: ConstructorParameters<typeof Markdown>
): Markdown;
