/** Component-rendered fixtures, not terminal screenshots or manual IME validation.
 * Reproduce from the repository root:
 * node --import tsx docs/validation/workbench-20261030/preview.mts
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import {
  CURSOR_MARKER,
  FAKE_CURSOR_START,
  FAKE_CURSOR_END,
} from "@earendil-works/pi-tui/dist/tui.js";
import {
  TuiAltScreen,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import { HikaroView } from "../../../packages/tui/src/index.ts";
import { setColorScheme } from "../../../packages/tui/src/theme.ts";

const directory = join(import.meta.dirname, "frames");
const sizes = [
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
] as const;
const themes = ["dark", "light", "no-color"] as const;
const scenarios = ["conversation", "menu", "draft"] as const;
const representatives = new Set([
  "dark-120x40-conversation",
  "light-80x24-menu",
  "no-color-60x18-draft",
  "dark-40x12-menu",
  "light-40x12-draft",
  "no-color-40x12-conversation",
]);
const previews: {
  name: string;
  theme: string;
  columns: number;
  rows: number;
  lines: string[];
}[] = [];
const results: {
  name: string;
  checks: Record<string, boolean>;
  issues: string[];
}[] = [];
const priorNoColor = process.env.NO_COLOR;
await mkdir(directory, { recursive: true });
try {
  for (const theme of themes)
    for (const [columns, rows] of sizes)
      for (const scenario of scenarios) {
        if (theme === "no-color") process.env.NO_COLOR = "1";
        else delete process.env.NO_COLOR;
        setColorScheme(theme === "light");
        const terminal: Terminal = {
          columns,
          rows,
          kittyProtocolActive: false,
          start() {},
          stop() {},
          async drainInput() {},
          write() {},
          moveBy() {},
          hideCursor() {},
          showCursor() {},
          clearLine() {},
          clearFromCursor() {},
          clearScreen() {},
          setTitle() {},
          setProgress() {},
          setProgramStatus() {},
        };
        const tui = new TuiAltScreen(terminal);
        tui.requestRender = () => {};
        const view = new HikaroView(tui, {
          cwd: "/workspace/hikaro",
          model: "local/code-model",
          onPrompt: async () => {},
          onCommand: async () => {},
          onExit() {},
        });
        tui.setFocus(view.editor);
        const name = `${theme}-${columns}x${rows}-${scenario}`;
        let seq = 0;
        const event = (type: string, data: Record<string, unknown>) =>
          view.event({
            type,
            data,
            seq: ++seq,
            timestamp: seq,
            sessionId: "preview",
          });
        let close: (() => void) | undefined;
        try {
          view.setStatus({
            connection: "connected",
            permission: "Full Access",
            branch: "main",
            usage: { input: 2400, output: 380, cost: 0.012 },
          });
          view.showMessages([
            { role: "user", text: "为登录接口补充错误处理", timestamp: 1 },
            {
              role: "assistant",
              text: "我会先检查认证流程及现有测试。\n\n检查 `src/auth.ts`，保留现有权限边界。",
              timestamp: 2,
            },
          ]);
          event("run.start", {});
          event("tool.start", {
            callId: "read",
            name: "read_file",
            arguments: { path: "src/auth.ts" },
          });
          event("tool.end", {
            callId: "read",
            name: "read_file",
            result: { text: "export async function authenticate() {}" },
          });
          event("tool.start", {
            callId: "test",
            name: "shell",
            arguments: { command: "pnpm test auth.test.ts" },
          });
          view.editor.setText("补充超时场景的测试");
          if (scenario === "menu") {
            event("tool.end", {
              callId: "test",
              name: "shell",
              result: { text: "12 tests passed" },
            });
            event("run.end", { status: "completed" });
            const opened = view.openModelPanel();
            close = opened.close;
            void opened.panel
              .choose(
                "Models",
                [
                  {
                    value: "fast",
                    label: "Fast",
                    description: "Quick iterations",
                  },
                  {
                    value: "balanced",
                    label: "Balanced",
                    description: "Balanced coding and analysis",
                  },
                  {
                    value: "careful",
                    label: "Careful",
                    description: "Complex changes with longer reasoning",
                  },
                  {
                    value: "local",
                    label: "Local",
                    description: "Local compatible endpoint",
                  },
                ],
                "",
                undefined,
                { search: true, selectedValue: "balanced" },
              )
              .catch(() => {});
          } else if (scenario === "draft") {
            event("run.end", { status: "cancelled" });
            view.editor.setText(
              Array.from(
                { length: 12 },
                (_, index) => `草稿 ${index + 1}: check timeout handling 🙂`,
              ).join("\n"),
            );
          }
          // Repeat after scroll layout settles, just as the renderer requests a frame.
          renderLayoutFrame(view.layout, columns, rows, () => {});
          const frame = renderLayoutFrame(view.layout, columns, rows, () => {});
          const plain = stripVTControlCharacters(
            frame.lines
              .join("\n")
              .replaceAll(CURSOR_MARKER, "")
              .replaceAll(FAKE_CURSOR_START, "")
              .replaceAll(FAKE_CURSOR_END, ""),
          );
          const markers = frame.lines.flatMap((line, y) =>
            line.includes(CURSOR_MARKER) ? [y] : [],
          );
          const checks = {
            boundedRows: frame.lines.length <= rows,
            boundedColumns: frame.lines.every(
              (line) => visibleWidth(line) <= columns,
            ),
            permissionVisible: plain.includes("Full Access"),
            cursorVisible: markers.length === 1,
            inputHorizonVisible: plain.includes("─ Message"),
            relevantContentVisible:
              scenario === "menu"
                ? plain.includes("→ Balanced")
                : scenario === "draft"
                  ? plain.includes("草稿 12")
                  : plain.includes("Running"),
            roleLabelsVisibleWhenRoomy:
              columns < 120 ||
              scenario !== "conversation" ||
              (plain.includes("YOU") && plain.includes("HIKARO")),
            monochrome:
              theme !== "no-color" ||
              !/\x1b\[(?:[0-9;]*[34]8;|3[0-7]m|4[0-7]m)/.test(
                frame.lines.join("\n"),
              ),
          };
          const issues = Object.entries(checks)
            .filter(([, passed]) => !passed)
            .map(([label]) => label);
          results.push({ name, checks, issues });
          if (representatives.has(name)) {
            previews.push({ name, theme, columns, rows, lines: frame.lines });
            await writeFile(
              join(directory, `${name}.txt`),
              `Component-rendered fixture, not a terminal screenshot.\n${name}\n${plain
                .split("\n")
                .map((line) => line.trimEnd())
                .join("\n")}\n`,
            );
          }
        } finally {
          close?.();
          view.dispose();
        }
      }
} finally {
  if (priorNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = priorNoColor;
  setColorScheme(false);
}

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function htmlLine(line: string) {
  const prepared = line
    .replaceAll(CURSOR_MARKER + FAKE_CURSOR_START, "\x1b[7m")
    .replaceAll(CURSOR_MARKER, "")
    .replaceAll(FAKE_CURSOR_START, "")
    .replaceAll(FAKE_CURSOR_END, "\x1b[27m");
  let foreground = "inherit",
    background = "transparent",
    weight = "normal",
    italic = false,
    inverse = false;
  let output = "",
    offset = 0;
  const append = (text: string) => {
    const style = `color:${foreground};background:${background};font-weight:${weight};font-style:${italic ? "italic" : "normal"};${inverse ? "outline:1px solid currentColor" : ""}`;
    output += `<span style="${style}">${escape(stripVTControlCharacters(text))}</span>`;
  };
  const codes = /\x1b\[([\d;]*)m/g;
  for (const match of prepared.matchAll(codes)) {
    append(prepared.slice(offset, match.index));
    const values = (match[1] || "0").split(";").map(Number);
    for (let index = 0; index < values.length; index++) {
      const code = values[index];
      if (code === 0) {
        foreground = "inherit";
        background = "transparent";
        weight = "normal";
        italic = inverse = false;
      } else if (code === 1) weight = "bold";
      else if (code === 22) weight = "normal";
      else if (code === 3) italic = true;
      else if (code === 23) italic = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
      else if (code === 39) foreground = "inherit";
      else if (code === 49) background = "transparent";
      else if (code === 31) foreground = "#cc5544";
      else if ((code === 38 || code === 48) && values[index + 1] === 2) {
        const color = `rgb(${values.slice(index + 2, index + 5).join(",")})`;
        if (code === 38) foreground = color;
        else background = color;
        index += 4;
      }
    }
    offset = match.index + match[0].length;
  }
  append(prepared.slice(offset));
  return output;
}
await writeFile(
  join(directory, "matrix.json"),
  JSON.stringify(
    {
      scope:
        "Real HikaroView / Pi layout component fixtures; not terminal screenshots or IME acceptance",
      frames: results.length,
      failed: results.filter((item) => item.issues.length),
      results,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(directory, "preview.html"),
  `<!doctype html><meta charset="utf-8"><title>Hikaro workbench component fixtures</title>
<style>body{font:15px system-ui;background:#e7e7e3;color:#12120f;margin:32px}h1{font-size:25px}p{max-width:850px;line-height:1.6}article{margin:32px 0}h2{font-size:16px}pre{display:inline-block;padding:12px;overflow:auto;max-width:calc(100vw - 88px);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}.dark{background:#12120f;color:#f7f7f6}.light,.no-color{background:#f7f7f6;color:#12120f}</style>
<h1>Hikaro · 安静的工作台</h1><p>These are component-rendered fixtures produced by the real HikaroView and Pi layout engine, using an isolated terminal stub. They are not actual terminal screenshots. Backgrounds are preview surfaces; the product retains the terminal's native background. The outlined cursor is a static illustration of the emitted cursor marker. Chinese IME placement, font metrics and clipboard selection require real-terminal validation.</p><p>36 combinations checked: four sizes × three themes × conversation/menu/long draft. ${results.filter((item) => item.issues.length).length} combinations have failed checks. Six representative frames follow.</p>${previews.map((item) => `<article><h2>${escape(item.name)}</h2><pre class="${item.theme}">${item.lines.map(htmlLine).join("\n")}</pre></article>`).join("\n")}`,
);
const failed = results.filter((item) => item.issues.length);
console.log(
  JSON.stringify(
    {
      checked: results.length,
      representatives: previews.length,
      failed,
      preview: join(directory, "preview.html"),
    },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
