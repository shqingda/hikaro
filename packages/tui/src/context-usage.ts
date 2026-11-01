import { truncateToWidth, type Component } from "./primitives.ts";
import { bold, isLightScheme, muted } from "./theme.ts";

/** What the next request would put in the context window (Agent.contextUsage). */
export type ContextUsage = {
  provider: string;
  model: string;
  contextWindow: number;
  used: number;
  system: number;
  tools: number;
  toolCount: number;
  messages: number;
  images: number;
  messageCount: number;
  outputReserve: number;
  safety: number;
  budget: number;
  compactAt: number;
  compacted: boolean;
  omitted: number;
};

/** 256000 → 256K, 1000000 → 1M, 18234 → 18.2K. */
export function formatTokens(tokens: number) {
  const unit = (value: number, suffix: string) =>
    `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (tokens >= 1_000_000) return unit(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return unit(tokens / 1_000, "K");
  return String(Math.max(0, Math.round(tokens)));
}

const paint = (text: string, dark: string, light: string) =>
  process.env.NO_COLOR === undefined
    ? `\x1b[38;2;${isLightScheme() ? light : dark}m${text}\x1b[39m`
    : text;
const plain = (text: string) => text;

/**
 * The /context view, after Grok Build: used / window, a 100-cell bar by
 * category and a legend. Colors resolve on every render so a light/dark
 * switch repaints it.
 */
export class ContextUsageBlock implements Component {
  constructor(private readonly usage: ContextUsage) {}

  invalidate() {}

  render(width: number) {
    const u = this.usage;
    const total = Math.max(1, u.contextWindow);
    const reserve = u.outputReserve + u.safety;
    const free = Math.max(0, total - u.used - reserve);
    const share = (tokens: number) => `${((tokens / total) * 100).toFixed(1)}%`;
    const rows = [
      {
        label: "System prompt",
        tokens: u.system,
        glyph: "◆",
        tone: (t: string) => paint(t, "150;150;140", "120;120;112"),
      },
      {
        label: "Tool definitions",
        tokens: u.tools,
        glyph: "◈",
        tone: (t: string) => paint(t, "86;190;180", "20;128;120"),
        detail: `${u.toolCount} ${u.toolCount === 1 ? "tool" : "tools"}`,
      },
      {
        label: "Messages",
        tokens: u.messages,
        glyph: "◆",
        tone: plain,
        detail: `${u.messageCount} ${u.messageCount === 1 ? "message" : "messages"}`,
      },
      ...(u.images
        ? [
            {
              label: "Images",
              tokens: u.images,
              glyph: "◆",
              tone: (t: string) => paint(t, "86;214;126", "22;140;62"),
            },
          ]
        : []),
      {
        label: "Reply reserve",
        tokens: reserve,
        glyph: "◊",
        tone: (t: string) => paint(t, "196;85;72", "196;85;72"),
        detail: "output and safety margin",
      },
      { label: "Free", tokens: free, glyph: "◇", tone: muted },
    ];

    // 5 × 20 cells when there is room, 10 × 10 on narrow terminals.
    const narrow = width < 50;
    const perRow = narrow ? 10 : 20;
    const cells: string[] = [];
    let filled = 0;
    for (const row of rows.slice(0, -1)) {
      const want = Math.round(((filled + row.tokens) / total) * 100);
      const count = Math.max(0, Math.min(100, want) - cells.length);
      for (let i = 0; i < count; i++) cells.push(row.tone(row.glyph));
      filled += row.tokens;
    }
    const last = rows.at(-1)!;
    while (cells.length < 100) cells.push(last.tone(last.glyph));
    const bar: string[] = [];
    for (let i = 0; i < 100; i += perRow)
      bar.push(" " + cells.slice(i, i + perRow).join(" "));

    const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 1;
    const tokenWidth = Math.max(
      ...rows.map((row) => formatTokens(row.tokens).length),
    );
    const shareWidth = Math.max(...rows.map((row) => share(row.tokens).length));
    const legend = rows.flatMap((row) => {
      const numbers = `${formatTokens(row.tokens).padStart(tokenWidth)} tokens  ${`(${share(row.tokens)})`.padStart(shareWidth + 2)}${row.detail ? ` · ${row.detail}` : ""}`;
      return narrow
        ? [` ${row.tone(row.glyph)} ${row.label}`, `   ${muted(numbers)}`]
        : [
            ` ${row.tone(row.glyph)} ${row.label.padEnd(labelWidth)} ${muted(numbers)}`,
          ];
    });

    const left = Math.max(0, u.compactAt - u.used);
    const compaction =
      u.used >= u.compactAt
        ? paint(
            "Earlier history is summarized before the next request",
            "230;180;80",
            "160;110;0",
          )
        : muted(
            `Auto-compact at ${formatTokens(u.compactAt)} · ~${formatTokens(left)} tokens left`,
          );
    const lines = [
      "",
      " " + bold("Context"),
      "",
      ` ${formatTokens(u.used)} / ${formatTokens(u.contextWindow)} tokens (${((u.used / total) * 100).toFixed(2)}%)`,
      " " + muted(`${u.provider}/${u.model}`),
      "",
      ...bar,
      "",
      ...legend,
      "",
      " " + compaction,
      ...(u.compacted || u.omitted
        ? [
            " " +
              muted(
                u.compacted
                  ? "Earlier turns are carried as a summary; originals stay in session history"
                  : `${u.omitted} earlier messages are left out of the request`,
              ),
          ]
        : []),
      " " + muted("Estimated with a conservative heuristic, not a tokenizer"),
      "",
    ];
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
}
