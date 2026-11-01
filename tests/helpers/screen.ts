import { stripVTControlCharacters } from "node:util";

/** Panel text with borders and wrapping removed, so assertions read words, not layout. */
export const screenText = (lines: string[] | string) =>
  stripVTControlCharacters(Array.isArray(lines) ? lines.join("\n") : lines)
    .replace(/\x1b_pi:[^\x07]*\x07/g, "")
    .replace(/[│╭╮╰╯─]/g, " ")
    .replace(/\s+/g, " ");
