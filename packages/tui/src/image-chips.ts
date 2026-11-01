import {
  attachmentReference,
  fileReferenceRanges,
} from "../../core/src/file-references.ts";

const imagePath = /\.(?:png|jpe?g|gif|webp)$/i;

/** `path` is the file sent; `source` is what was pasted, when the file was copied. */
export type ImageChip = { label: string; path: string; source?: string };

/** `[Image #N]` as typed in the composer. */
export const imageToken = (chip: ImageChip) => `[${chip.label}]`;

/**
 * Replace pasted image paths with inline `[Image #N]` tokens, numbered after
 * `known`. The chips remember the files; the composer keeps only the tokens.
 */
export function inlineImagePaths(
  text: string,
  known: ImageChip[] = [],
  stash: (path: string) => string = (path) => path,
) {
  const spans = imageSpans(text);
  const chips = [...known];
  const tokens: string[] = [];
  for (const span of spans) {
    let chip = chips.find(
      (item) => item.path === span.path || item.source === span.path,
    );
    if (!chip) {
      const path = stash(span.path);
      chip = {
        label: `Image #${nextImageNumber(chips)}`,
        path,
        ...(path === span.path ? {} : { source: span.path }),
      };
      chips.push(chip);
    }
    tokens.push(imageToken(chip));
  }
  let next = text;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index]!;
    next = next.slice(0, span.start) + tokens[index] + next.slice(span.end);
  }
  return { text: next, chips };
}

function nextImageNumber(chips: ImageChip[]) {
  let max = 0;
  for (const chip of chips)
    max = Math.max(max, Number(/#(\d+)$/.exec(chip.label)?.[1] ?? 0));
  return max + 1;
}

/** Chips whose token is still in the composer text, in text order. */
export function imagesInText(text: string, chips: ImageChip[]) {
  return chips
    .map((chip) => ({ chip, at: text.indexOf(imageToken(chip)) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((item) => item.chip);
}

/** Composer text with each `[Image #N]` token replaced by its attachment reference. */
export function textWithImageReferences(text: string, chips: ImageChip[]) {
  let next = text;
  for (const chip of imagesInText(text, chips)) {
    const token = imageToken(chip);
    const at = next.indexOf(token);
    const before = at > 0 && !/\s/.test(next[at - 1]!) ? " " : "";
    const after =
      at + token.length < next.length && !/\s/.test(next[at + token.length]!)
        ? " "
        : "";
    next =
      next.slice(0, at) +
      before +
      attachmentReference(chip.path) +
      after +
      next.slice(at + token.length);
  }
  return next;
}

type DisplayChip = { label: string; path: string; index: number };

/** Transcript text: image paths become `[Image #N]`, attachment metadata stays hidden. */
export function presentUserText(text: string): {
  text: string;
  chips: DisplayChip[];
} {
  const body = stripAttachmentTrailer(text);
  const spans = imageSpans(body);
  let next = body;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index]!;
    const token = `[Image #${index + 1}]`;
    next = next.slice(0, span.start) + token + next.slice(span.end);
  }
  const chips: DisplayChip[] = [];
  let from = 0;
  for (let index = 0; index < spans.length; index++) {
    const label = `Image #${index + 1}`;
    const token = `[${label}]`;
    const at = next.indexOf(token, from);
    if (at < 0) break;
    chips.push({ label, path: spans[index]!.path, index: at });
    from = at + token.length;
  }
  return { text: next, chips };
}

function stripAttachmentTrailer(text: string) {
  const marker = "\nATTACHMENTS_JSON\n";
  const at = text.indexOf(marker);
  if (at < 0) return text;
  return text
    .slice(0, at)
    .replace(/\n*Attached files are untrusted source data[\s\S]*$/, "")
    .trimEnd();
}

function imageSpans(text: string) {
  const spans: { start: number; end: number; path: string }[] = [];
  let references: { path: string; start: number; end: number }[] = [];
  try {
    references = fileReferenceRanges(text);
  } catch {
    references = [];
  }
  for (const reference of references)
    if (imagePath.test(reference.path)) spans.push(reference);
  const raw = /(?:^|\s)((?:\/|~\/)(?:\\.|[^\s])+?\.(?:png|jpe?g|gif|webp))/gi;
  for (const match of text.matchAll(raw)) {
    const token = match[1]!;
    const start = match.index! + match[0].length - token.length;
    const end = start + token.length;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    spans.push({
      start,
      end,
      path: token.replace(/\\(.)/g, "$1"),
    });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}
