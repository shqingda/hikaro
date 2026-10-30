const maxFiles = 8;
/** Only explicit, whitespace-delimited references outside Markdown code. */
export type FileReference = { path: string; start: number; end: number };
export function fileReferenceRanges(text: string): FileReference[] {
  const paths: FileReference[] = [];
  let code = 0;
  let codeMark = "";
  let fenced = false;
  for (let i = 0; i < text.length; i++) {
    if (
      text[i] === "`" ||
      (text[i] === "~" &&
        (codeMark === "~" ||
          /^ {0,3}$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))))
    ) {
      let end = i;
      while (text[end] === text[i]) end++;
      const count = end - i;
      if (text[i] === "~" && count < 3) continue;
      if (!code) {
        code = count;
        codeMark = text[i]!;
        fenced =
          count >= 3 &&
          /^ {0,3}$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
      } else if (text[i] === codeMark) {
        const lineEnd = text.indexOf("\n", end);
        const closesFence =
          count >= code &&
          /^ {0,3}$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i)) &&
          /^\s*$/.test(text.slice(end, lineEnd < 0 ? undefined : lineEnd));
        if (fenced ? closesFence : count === code) code = 0;
      }
      i = end - 1;
      continue;
    }
    if (
      code ||
      text[i] !== "@" ||
      (i && !/\s/.test(text[i - 1]!)) ||
      text[i + 1] === "@"
    )
      continue;
    let index = i + 1;
    const quote =
      text[index] === '"' || text[index] === "'" ? text[index++] : undefined;
    let path = "";
    for (; index < text.length; index++) {
      const char = text[index]!;
      if (quote ? char === quote : /\s/.test(char)) break;
      if (char === "\\" && index + 1 < text.length) path += text[++index];
      else path += char;
    }
    if (quote && text[index] !== quote)
      throw Error("Close the quote around the attachment path.");
    if (quote && index + 1 < text.length && !/\s/.test(text[index + 1]!))
      throw Error("Separate attachment references with a space.");
    if (path) {
      if (/[\x00-\x1f\x7f]/.test(path) || path.length > 4096)
        throw Error("Invalid attachment path.");
      paths.push({ path, start: i, end: quote ? index + 1 : index });
      if (paths.length > maxFiles)
        throw Error(`Use at most ${maxFiles} attachments per message.`);
    }
    i = index;
  }
  return paths;
}

export function parseFileReferences(text: string): string[] {
  return fileReferenceRanges(text).map((reference) => reference.path);
}

/** One path supplied by /attach; unlike inline @ syntax, spaces are unambiguous. */
export function attachmentReference(input: string): string {
  const value = input.trim();
  let path: string;
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.at(-1) !== value[0])
      throw Error("Close the quote around the attachment path.");
    const parsed = parseFileReferences("@" + value);
    if (parsed.length !== 1) throw Error("Provide one attachment path.");
    path = parsed[0]!;
  } else path = value.replace(/\\(.)/g, "$1");
  const reference = "@" + JSON.stringify(path);
  if (
    !path ||
    /[\x00-\x1f\x7f]/.test(path) ||
    parseFileReferences(reference)[0] !== path
  )
    throw Error("Invalid attachment path.");
  return reference;
}
