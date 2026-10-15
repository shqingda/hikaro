import { stripVTControlCharacters } from "node:util";

export function sanitize(text: string) {
  return stripVTControlCharacters(text).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    "",
  );
}
