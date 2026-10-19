import { expect, it } from "vitest";
import { CONTENT_STEP, contentPage } from "../apps/mobile/src/content.ts";

const response = (text: string, offset: number) => {
  const begin = Math.max(0, offset - 1);
  const end = Math.min(text.length, begin + 8192);
  return {
    data: text.slice(begin, end),
    total: text.length,
    nextOffset: end < text.length ? end : null,
    encoding: "utf16",
  };
};

it("reads bounded fixed pages without splitting Unicode pairs or accumulating history", () => {
  const text =
    "中".repeat(CONTENT_STEP - 1) +
    "🌅" +
    "文".repeat(CONTENT_STEP - 1) +
    "🦉结尾";
  const pages = [0, CONTENT_STEP, CONTENT_STEP * 2].map((offset) =>
    contentPage(response(text, offset), offset),
  );
  expect(pages.map((page) => page.data).join("") === text).toBe(true);
  expect(pages.every((page) => page.data.length <= 8191)).toBe(true);
  expect(pages[0]!.nextOffset).toBe(CONTENT_STEP);
  expect(pages[2]!.nextOffset).toBeNull();
  expect(contentPage(response(text, CONTENT_STEP), CONTENT_STEP)).toEqual(
    pages[1],
  );
  expect(contentPage(response("", 0), 0).data).toBe("");
});

it("rejects oversized text, wrong encoding, inconsistent cursors and invalid page boundaries", () => {
  const valid = response("a".repeat(20000), 0);
  for (const broken of [
    { ...valid, data: "x".repeat(8193) },
    { ...valid, encoding: "base64" },
    { ...valid, nextOffset: 0 },
    { ...valid, nextOffset: null },
    { ...valid, total: -1 },
    { ...valid, data: "truncated" },
  ])
    expect(() => contentPage(broken, 0)).toThrow();
  for (const offset of [-1, 1, Number.MAX_SAFE_INTEGER, Infinity])
    expect(() => contentPage(valid, offset)).toThrow();
  expect(() => contentPage(response("short", 0), CONTENT_STEP)).toThrow();
});
