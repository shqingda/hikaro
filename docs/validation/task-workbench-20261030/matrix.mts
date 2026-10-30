/** Production component fixtures, NOT real terminal screenshots or IME acceptance.
 * node --import tsx docs/validation/task-workbench-20261030/matrix.mts
 */
import { mkdir, writeFile } from "node:fs/promises";
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
import { ObjectPage } from "../../../packages/tui/src/object-page.ts";
const directory = join(import.meta.dirname, "matrix");
await mkdir(directory, { recursive: true });
const frames: Record<string, unknown>[] = [];
const sizes = [
  [144, 40],
  [120, 40],
  [80, 24],
  [60, 18],
  [40, 12],
] as const;
const draft = "Review timeout handling 中文 @auth.ts";
const source =
  'export async function authenticate(token: string) {\n  if (!token) throw new Error("Missing token");\n  return { authenticated: true };\n}';
const previousNoColor = process.env.NO_COLOR;
try {
  for (const theme of ["dark", "light", "no-color"] as const)
    for (const [columns, rows] of sizes)
      for (const scenario of [
        "conversation",
        "models",
        "context",
        "context-search",
        "draft",
        "autocomplete",
      ] as const) {
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
        let close: (() => void) | undefined;
        try {
          view.setStatus({
            connection: "connected",
            permission: "Workspace write",
            branch: "main",
            usage: { input: 2400, output: 380, cost: 0.012 },
          });
          view.setSessions([
            {
              id: "active",
              title: "Login timeout",
              current: true,
              state: "Ready",
            },
            {
              id: "background",
              title: "API tests",
              current: false,
              state: "Working",
              unread: true,
            },
          ]);
          view.showMessages([
            { role: "user", text: "为登录接口补充错误处理", timestamp: 1 },
            {
              role: "assistant",
              text: "我会先检查认证流程及现有测试。\n\n检查 `src/auth.ts`，保留现有权限边界。",
              timestamp: 2,
            },
          ]);
          view.editor.setText(draft);
          if (scenario === "autocomplete" || scenario === "context-search") {
            view.editor.setAutocompleteProvider({
              triggerCharacters: ["@"],
              async getSuggestions() {
                return {
                  prefix: "@",
                  items: [
                    { value: "auth.ts", label: "Complete auth.ts" },
                    { value: "auth.test.ts", label: "Complete auth.test.ts" },
                  ],
                };
              },
              applyCompletion(lines, cursorLine, cursorCol) {
                return { lines, cursorLine, cursorCol };
              },
            });
            view.editor.setText(draft.slice(0, draft.indexOf("@")));
            view.editor.handleInput("@");
            view.editor.handleInput("auth.ts");
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (!view.editor.isShowingAutocomplete())
              throw Error("Autocomplete fixture did not open");
          }
          if (scenario === "conversation") {
            view.event({
              type: "run.start",
              data: {},
              seq: 1,
              timestamp: 1,
              sessionId: "active",
            });
            view.event({
              type: "tool.start",
              data: {
                callId: "test",
                name: "shell",
                arguments: { command: "pnpm test auth.test.ts" },
              },
              seq: 2,
              timestamp: 2,
              sessionId: "active",
            });
          } else if (scenario === "models") {
            const opened = view.openModelPanel();
            close = opened.close;
            void opened.panel
              .choose(
                "Select model",
                [
                  {
                    value: "fast",
                    label: "Fast",
                    section: "Recent",
                    detail: "local/fast\nContext 128k · Images · Reasoning",
                  },
                  {
                    value: "balanced",
                    label: "★ Balanced",
                    section: "Favorites",
                    detail: "local/balanced\nContext 200k · Images · Reasoning",
                  },
                  {
                    value: "careful",
                    label: "Careful",
                    section: "local",
                    detail: "local/careful\nContext 256k · Reasoning",
                  },
                ],
                "",
                undefined,
                {
                  search: true,
                  selectedValue: "balanced",
                  tabs: [
                    { value: "models", label: "Models" },
                    { value: "providers", label: "Providers" },
                  ],
                  activeTab: "models",
                  allowDefault: true,
                },
              )
              .catch(() => {});
          } else if (scenario === "context" || scenario === "context-search") {
            view.setWorkspaceSources({
              Context: {
                title: "Context",
                description:
                  "Draft attachments, active model, workspace instructions, skills, and tools",
                load: async () => [
                  {
                    id: "draft",
                    title: "Draft and attachments",
                    group: "Input",
                  },
                  {
                    id: "attachment",
                    title: "auth.ts",
                    group: "Draft attachment",
                  },
                  { id: "model", title: "Model and context", group: "Model" },
                ],
                detail: async () => ({
                  title: "auth.ts",
                  text: `Draft attachment\n@auth.ts\n\nPreview fixture; not submitted\n\n${source}`,
                  actions: [
                    {
                      id: "remove",
                      title: "Remove attachment from draft",
                      run() {},
                    },
                    { id: "return", title: "Return to input", run() {} },
                  ],
                }),
              },
            });
            await view.openWorkspaceObject("Context", "attachment");
            if (scenario === "context-search") {
              const page = tui.getFocusedComponent();
              if (!(page instanceof ObjectPage))
                throw Error("Context fixture is not focused");
              page.handleInput("/");
              page.handleInput("auth.ts");
              page.handleInput("\r");
              await page.inspect();
            }
          } else if (scenario === "draft")
            view.editor.setText(
              Array.from(
                { length: 12 },
                (_, i) => `草稿 ${i + 1}: check timeout handling`,
              ).join("\n") + " @auth.ts",
            );
          renderLayoutFrame(view.layout, columns, rows, () => {});
          const frame = renderLayoutFrame(view.layout, columns, rows, () => {});
          const cursor = frame.lines.flatMap((line, y) => {
            const index = line.indexOf(CURSOR_MARKER);
            return index < 0
              ? []
              : [{ x: visibleWidth(line.slice(0, index)), y }];
          });
          const lines = frame.lines.map((line) =>
            line
              .replaceAll(CURSOR_MARKER, "")
              .replaceAll(FAKE_CURSOR_START, "")
              .replaceAll(FAKE_CURSOR_END, ""),
          );
          const plain = stripVTControlCharacters(lines.join("\n"));
          const checks = {
            boundedRows: lines.length <= rows,
            boundedColumns: lines.every(
              (line) => visibleWidth(line) <= columns,
            ),
            permissionVisible: plain.includes("Workspace write"),
            stateVisible: /Ready|Running|Working/.test(plain),
            cursorPosition: cursor.every(
              (item) =>
                item.x >= 0 && item.x < columns && item.y >= 0 && item.y < rows,
            ),
            correctFocus:
              cursor.length === (scenario.startsWith("context") ? 0 : 1),
            selectedOrRelevantContentVisible:
              scenario === "models"
                ? plain.includes("→ ★ Balanced")
                : scenario.startsWith("context")
                  ? plain.includes("auth.ts") &&
                    plain.includes("Remove attachment")
                  : scenario === "draft"
                    ? plain.includes("草稿 12")
                    : scenario === "autocomplete"
                      ? plain.includes("→ Complete auth.ts")
                      : plain.includes("Running shell"),
            completionBelongsToFocus:
              scenario !== "context-search" ||
              !plain.includes("Complete auth.ts"),
            draftPreserved:
              view.editor.getExpandedText() ===
              (scenario === "draft"
                ? Array.from(
                    { length: 12 },
                    (_, i) => `草稿 ${i + 1}: check timeout handling`,
                  ).join("\n") + " @auth.ts"
                : draft),
            noColor:
              theme !== "no-color" ||
              !/\x1b\[(?:[0-9;]*[34]8;|3[0-7]m|4[0-7]m)/.test(lines.join("\n")),
          };
          const issues = Object.entries(checks)
            .filter(([, passed]) => !passed)
            .map(([key]) => key);
          frames.push({
            name,
            theme,
            scenario,
            columns,
            rows,
            lines,
            cursor,
            checks,
            issues,
          });
          await writeFile(
            join(directory, `${name}.txt`),
            `PRODUCTION COMPONENT FIXTURE · not a real terminal capture\n${name}\n${plain}\n`,
          );
        } finally {
          close?.();
          view.dispose();
        }
      }
} finally {
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
  setColorScheme(false);
}
const failed = frames.filter((frame) => (frame.issues as string[]).length);
await writeFile(
  join(directory, "frames.json"),
  JSON.stringify(
    {
      scope:
        "Production HikaroView/Pi layout fixtures with deterministic data, not PTY screenshots or IME validation",
      frames,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(directory, "checks.json"),
  JSON.stringify(
    {
      frames: frames.length,
      failed: failed.map(({ name, checks, issues }) => ({
        name,
        checks,
        issues,
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    frames: frames.length,
    failed: failed.map(({ name, issues }) => ({ name, issues })),
  }),
);
if (failed.length) process.exitCode = 1;
