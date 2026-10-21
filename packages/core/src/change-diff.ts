/** One exact replacement hunk; common prefix/suffix stay out of large previews. */
export function changeDiff(
  path: string,
  before: string | undefined,
  after: string,
) {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const old = lines(before ?? "");
  const next = lines(after);
  const display = (prefix: string, line: string) =>
    line.endsWith("\n")
      ? prefix + line.slice(0, -1)
      : prefix + line + "\n\\ No newline at end of file";
  let start = 0,
    end = 0;
  while (
    start < old.length &&
    start < next.length &&
    old[start] === next[start]
  )
    start++;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - 3);
  const oldEnd = Math.min(old.length, old.length - end + 3);
  const newEnd = Math.min(next.length, next.length - end + 3);
  return [
    `--- ${before === undefined ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ -${oldEnd === from ? from : from + 1},${oldEnd - from} +${newEnd === from ? from : from + 1},${newEnd - from} @@`,
    ...old.slice(from, start).map((line) => display(" ", line)),
    ...old.slice(start, old.length - end).map((line) => display("-", line)),
    ...next.slice(start, next.length - end).map((line) => display("+", line)),
    ...next.slice(next.length - end, newEnd).map((line) => display(" ", line)),
  ].join("\n");
}
