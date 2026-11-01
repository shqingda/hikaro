import { isLightScheme, muted } from "./theme.ts";

const families = {
  c: new Set(
    "const let var function return if else for while class import export from async await new typeof interface type extends implements public private protected static void enum struct package func go defer range map chan def elif try except finally lambda None True False and or not in is pass yield as with if then fi do done case esac".split(
      " ",
    ),
  ),
  data: new Set("true false null undefined None True False".split(" ")),
};

type Family = "c" | "hash" | "html" | "data";

function family(lang = ""): Family {
  const name = lang.toLowerCase().replace(/^\./, "");
  if (
    [
      "py",
      "python",
      "pyi",
      "rb",
      "ruby",
      "sh",
      "bash",
      "zsh",
      "yml",
      "yaml",
      "toml",
    ].includes(name)
  )
    return "hash";
  if (["html", "xml", "svg"].includes(name)) return "html";
  if (["json", "jsonc"].includes(name)) return "data";
  return "c";
}

const paint = (text: string, dark: string, light: string) =>
  process.env.NO_COLOR === undefined
    ? `\x1b[38;2;${isLightScheme() ? light : dark}m${text}\x1b[39m`
    : text;

const keyword = (text: string) => paint(text, "130;177;255", "0;80;168");
const string = (text: string) => paint(text, "206;145;120", "163;58;21");
const number = (text: string) => paint(text, "181;206;168", "9;110;58");
const call = (text: string) => paint(text, "220;220;170", "121;94;38");

/** Line-oriented terminal colors for fenced code. Unknown languages still mark strings, numbers and comments. */
export function highlightCode(code: string, lang?: string) {
  const kind = family(lang);
  const words = kind === "data" ? families.data : families.c;
  const state = { block: false };
  return code
    .split("\n")
    .map((line) => highlightLine(line, kind, words, state));
}

function highlightLine(
  line: string,
  kind: Family,
  words: Set<string>,
  state: { block: boolean },
) {
  let out = "";
  let index = 0;
  const blockEnd = kind === "html" ? "-->" : "*/";
  while (index < line.length) {
    if (state.block) {
      const end = line.indexOf(blockEnd, index);
      if (end < 0) return out + muted(line.slice(index));
      out += muted(line.slice(index, end + blockEnd.length));
      index = end + blockEnd.length;
      state.block = false;
      continue;
    }
    const char = line[index]!;
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < line.length) {
        if (line[end] === "\\") {
          end += 2;
          continue;
        }
        if (line[end] === char) {
          end++;
          break;
        }
        end++;
      }
      out += string(line.slice(index, end));
      index = end;
      continue;
    }
    if (kind === "html" && line.startsWith("<!--", index)) {
      state.block = true;
      continue;
    }
    if (kind !== "hash" && kind !== "data" && line.startsWith("/*", index)) {
      state.block = true;
      continue;
    }
    if (
      (kind === "c" && line.startsWith("//", index)) ||
      (kind === "hash" && char === "#")
    )
      return out + muted(line.slice(index));
    if (
      /[0-9]/.test(char) &&
      (index === 0 || /[^A-Za-z0-9_]/.test(line[index - 1]!))
    ) {
      let end = index + 1;
      while (end < line.length && /[0-9A-Fa-fxX._]/.test(line[end]!)) end++;
      out += number(line.slice(index, end));
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < line.length && /[A-Za-z0-9_]/.test(line[end]!)) end++;
      const word = line.slice(index, end);
      let next = end;
      while (line[next] === " ") next++;
      out += words.has(word)
        ? keyword(word)
        : line[next] === "("
          ? call(word)
          : word;
      index = end;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}
