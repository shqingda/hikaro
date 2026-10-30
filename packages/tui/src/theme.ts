import type { MarkdownTheme } from "./primitives.ts";

let light = false;
const color = (text: string, start: string, end = "\x1b[39m") =>
  process.env.NO_COLOR === undefined ? start + text + end : text;

/** Terminal background remains untouched; only small semantic accents are colored. */
export function setColorScheme(isLight: boolean) {
  light = isLight;
}
export const accent = (text: string) =>
  color(text, light ? "\x1b[38;2;107;80;0m" : "\x1b[38;2;242;181;0m");
export const muted = (text: string) =>
  color(text, light ? "\x1b[38;2;98;98;90m" : "\x1b[38;2;167;167;156m");
export const bold = (text: string) => color(text, "\x1b[1m", "\x1b[22m");
export const error = (text: string) => color(text, "\x1b[31m");
export const selected = (text: string) =>
  color(text, "\x1b[48;2;242;181;0m\x1b[38;2;18;18;15m", "\x1b[49m\x1b[39m");

export const editorTheme = {
  borderColor: muted,
  selectList: {
    selectedPrefix: accent,
    selectedText: selected,
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  },
};

const identity = (text: string) => text;
export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: accent,
  linkUrl: muted,
  code: accent,
  codeBlock: identity,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic: (text) => color(text, "\x1b[3m", "\x1b[23m"),
  strikethrough: identity,
  underline: identity,
};
