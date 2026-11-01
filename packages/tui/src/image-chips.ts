import {
  attachmentReference,
  fileReferenceRanges,
} from "../../core/src/file-references.ts";

const imagePath = /\.(?:png|jpe?g|gif|webp)$/i;

export type ImageChip = { label: string; path: string };

/** Drop pasted image paths out of the composer. The chips remember the files. */
export function detachImagePaths(text: string) {
  const spans = imageSpans(text);
  let next = text;
  const paths: string[] = [];
  for (const span of [...spans].reverse()) {
    paths.unshift(span.path);
    let start = span.start;
    let end = span.end;
    if (next[end] === " ") end++;
    else if (start > 0 && /\s/.test(next[start - 1]!)) start--;
    next = next.slice(0, start) + next.slice(end);
  }
  const chips = paths.map((path, index) => ({
    label: `Image #${index + 1}`,
    path,
  }));
  return {
    text: next.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " "),
    chips,
  };
}

/** Composer text plus the hidden references submit and draft recovery need. */
export function textWithImageReferences(text: string, chips: ImageChip[]) {
  // The typed text stays byte for byte; references only follow it.
  if (!chips.length) return text;
  const refs = chips.map((chip) => attachmentReference(chip.path)).join(" ");
  return text && !/\s$/.test(text) ? `${text} ${refs}` : text + refs;
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
