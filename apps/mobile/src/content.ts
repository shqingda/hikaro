import * as z from "zod";

export const CONTENT_STEP = 8190;
const responseSchema = z.object({
  data: z.string().max(8192),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  encoding: z.literal("utf16"),
});
export function contentRequestOffset(offset: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % CONTENT_STEP !== 0 ||
    offset > Number.MAX_SAFE_INTEGER - 8192
  )
    throw Error("Invalid content page");
  return Math.max(0, offset - 1);
}
export function contentPage(raw: unknown, offset: number) {
  const begin = contentRequestOffset(offset);
  const value = responseSchema.parse(raw);
  const end = Math.min(value.total, begin + 8192);
  if (
    (offset > 0 && offset >= value.total) ||
    value.data.length !== Math.max(0, end - begin) ||
    value.nextOffset !== (end < value.total ? end : null)
  )
    throw Error("Inconsistent content page");
  let start = offset,
    finish = Math.min(value.total, offset + CONTENT_STEP);
  const high = (at: number) => {
    const n = value.data.charCodeAt(at - begin);
    return n >= 0xd800 && n <= 0xdbff;
  };
  const low = (at: number) => {
    const n = value.data.charCodeAt(at - begin);
    return n >= 0xdc00 && n <= 0xdfff;
  };
  // One-character lookbehind/lookahead keeps a valid surrogate pair on one page.
  if (start > 0 && high(start - 1) && low(start)) start++;
  if (finish < value.total && high(finish - 1) && low(finish)) finish++;
  return {
    data: value.data.slice(start - begin, finish - begin),
    total: value.total,
    nextOffset: finish < value.total ? offset + CONTENT_STEP : null,
  };
}
export type ContentPage = ReturnType<typeof contentPage>;
