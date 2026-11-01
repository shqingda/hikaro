import type { MarkdownTheme } from "./primitives.ts";
import { highlightCode } from "./highlight.ts";

let light = false;
const color = (text: string, start: string, end = "\x1b[39m") =>
  process.env.NO_COLOR === undefined ? start + text + end : text;

/** Terminal background remains untouched; only small semantic accents are colored. */
export function setColorScheme(isLight: boolean) {
  light = isLight;
}
export function isLightScheme() {
  return light;
}
/** 0.3.0 terracotta. One red for day and night. */
export const accent = (text: string) => color(text, "\x1b[38;2;196;85;72m");
export const muted = (text: string) =>
  color(text, light ? "\x1b[38;2;98;98;90m" : "\x1b[38;2;167;167;156m");
export const bold = (text: string) => color(text, "\x1b[1m", "\x1b[22m");
export const error = (text: string) => color(text, "\x1b[31m");
/** The 0.3.0 running indicator: terracotta, distinct from the Beam accent. */
export const working = (text: string) => color(text, "\x1b[38;2;196;85;72m");
/** Grok-style image chip. Green on both the day and night conversation bars. */
export const imageChip = (text: string) =>
  color(text, light ? "\x1b[38;2;22;140;62m" : "\x1b[38;2;86;214;126m");
/** Clock on a conversation row. Dimmer than the message, not a second accent. */
export const clock = (text: string) =>
  color(text, light ? "\x1b[38;2;120;120;120m" : "\x1b[38;2;168;168;168m");

/** User turns keep Pi's full-width bar in the 0.3.0 red wash. */
export function userMessageStyle() {
  if (process.env.NO_COLOR !== undefined) return;
  return light
    ? {
        background: "\x1b[48;2;244;225;219m",
        foreground: "\x1b[38;2;41;39;37m",
      }
    : {
        background: "\x1b[48;2;58;39;36m",
        foreground: "\x1b[38;2;244;237;236m",
      };
}
export const selected = (text: string) =>
  color(text, "\x1b[48;2;196;85;72m\x1b[38;2;255;245;242m", "\x1b[49m\x1b[39m");

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
  highlightCode,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic: (text) => color(text, "\x1b[3m", "\x1b[23m"),
  strikethrough: identity,
  underline: identity,
};

export const neutralSelected = (text: string) =>
  color(
    text,
    light
      ? "\x1b[48;2;225;225;220m\x1b[38;2;18;18;15m"
      : "\x1b[48;2;55;55;50m\x1b[38;2;245;245;240m",
    "\x1b[49m\x1b[39m",
  );
