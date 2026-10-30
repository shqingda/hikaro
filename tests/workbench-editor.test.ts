import { afterEach, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  CURSOR_MARKER,
  type TUI,
  type TuiMouseEvent,
} from "../packages/tui/src/primitives.ts";
import { ActivityEditor } from "../packages/tui/src/activity-editor.ts";
import {
  accent,
  bold,
  error,
  muted,
  selected,
  setColorScheme,
} from "../packages/tui/src/theme.ts";

const originalNoColor = process.env.NO_COLOR;
afterEach(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  setColorScheme(false);
  vi.useRealTimers();
});

function fixture(rows = 24) {
  const render = vi.fn();
  const tui = { terminal: { rows }, requestRender: render } as unknown as TUI;
  const editor = new ActivityEditor(tui);
  editor.focused = true;
  return { editor, render };
}

it("keeps one horizon, an independent hint and the native hardware cursor", () => {
  const { editor } = fixture();
  editor.setHint("Enter send · / commands · @ files");
  editor.setText("中文🙂");
  const lines = editor.render(60);
  expect(stripVTControlCharacters(lines[0]!)).toContain("Message");
  expect(lines[1]).toContain(CURSOR_MARKER);
  expect(stripVTControlCharacters(lines.at(-1)!)).toContain("Enter send");
  expect(stripVTControlCharacters(lines.at(-1)!)).not.toContain("─");
});

it.each([
  [40, 6],
  [24, 6],
  [18, 4],
  [12, 2],
])(
  "keeps the cursor and mouse coordinates correct in a %i-row terminal",
  (rows, bodyRows) => {
    const { editor } = fixture(rows);
    editor.setText(
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
    );
    const rendered = editor.render(40);
    expect(rendered).toHaveLength(bodyRows! + 2);
    expect(rendered[bodyRows!]).toContain(CURSOR_MARKER);
    expect(stripVTControlCharacters(rendered[bodyRows!]!)).toContain("line 19");
    expect(rendered.join("\n")).not.toContain("\0");
    editor.handleMouse({
      type: "click",
      button: "left",
      x: 1,
      y: 1,
      width: 40,
      height: rendered.length,
      screenX: 1,
      screenY: 1,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(editor.getCursor()).toEqual({ line: 20 - bodyRows!, col: 0 });
    expect(editor.render(40)[1]).toContain(CURSOR_MARKER);
    editor.focused = false;
    expect(editor.render(40).join("\n")).not.toContain(CURSOR_MARKER);
  },
);

it("preserves the cursor after an explicit one-row budget and a resize", () => {
  const { editor } = fixture(40);
  editor.setText("中文🙂".repeat(40));
  editor.setBodyRows(1);
  for (const width of [120, 80, 60, 40]) {
    const rendered = editor.render(width);
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toContain(CURSOR_MARKER);
    expect(editor.getExpandedText()).toBe("中文🙂".repeat(40));
  }
});

it("maps completion clicks above the cropped input without submitting or moving the draft cursor", async () => {
  const { editor } = fixture(12);
  const submit = vi.fn();
  editor.onSubmit = submit;
  editor.setAutocompleteProvider({
    triggerCharacters: ["@"],
    async getSuggestions() {
      return {
        prefix: "@",
        items: Array.from({ length: 8 }, (_, index) => ({
          value: `file${index}`,
          label: `file${index}`,
        })),
      };
    },
    applyCompletion(lines, cursorLine, _cursorCol, item) {
      return {
        lines: [...lines.slice(0, cursorLine), item.value],
        cursorLine,
        cursorCol: item.value.length,
      };
    },
  });
  editor.setText("first\nsecond\nthird\nfourth\n");
  editor.handleInput("@");
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
  const before = editor.getCursor();
  const rendered = editor.render(40);
  expect(editor.getAutocompleteMaxVisible()).toBe(3);
  expect(
    rendered.findIndex((line) => line.includes(CURSOR_MARKER)),
  ).toBeGreaterThan(3);
  expect(stripVTControlCharacters(rendered[0]!)).toContain("file0");
  editor.focused = false;
  expect(editor.render(40).join("\n")).not.toContain(CURSOR_MARKER);
  expect(editor.focused).toBe(false);
  expect(editor.getCursor()).toEqual(before);
  expect(editor.render(40).join("\n")).not.toContain("file0");
  // A completion row can only be clicked once focus and its visible layout return.
  editor.focused = true;
  editor.render(40);
  editor.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    width: 40,
    height: rendered.length,
    screenX: 4,
    screenY: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
  expect(editor.getText()).toBe("first\nsecond\nthird\nfourth\nfile1");
  expect(submit).not.toHaveBeenCalled();
});

it("preserves editing coordinates, Unicode cursor placement, paste undo and completion limits", () => {
  const { editor } = fixture();
  editor.setText("中文🙂");
  editor.render(60);
  editor.handleMouse({
    type: "click",
    button: "left",
    x: 3,
    y: 1,
    width: 60,
    height: 3,
    screenX: 3,
    screenY: 1,
    shift: false,
    alt: false,
    ctrl: false,
  } satisfies TuiMouseEvent);
  expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
  editor.insertTextAtCursor("一\n二");
  expect(editor.getText()).toBe("中一\n二文🙂");
  editor.handleInput("\x1f");
  expect(editor.getText()).toBe("中文🙂");
  expect(editor.getAutocompleteMaxVisible()).toBe(5);
});

it("does not animate or repaint unchanged hints", () => {
  vi.useFakeTimers();
  const { editor, render } = fixture();
  editor.setHint("Enter send");
  render.mockClear();
  editor.setHint("Enter send");
  editor.setActivity("Working", true);
  vi.advanceTimersByTime(1000);
  expect(render).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  editor.dispose();
});

it("uses readable light emphasis and honors NO_COLOR for every presentation helper", () => {
  delete process.env.NO_COLOR;
  setColorScheme(false);
  const dark = accent("Hikaro");
  setColorScheme(true);
  expect(accent("Hikaro")).not.toBe(dark);
  expect(stripVTControlCharacters(selected("Choice"))).toBe("Choice");
  process.env.NO_COLOR = "1";
  for (const format of [accent, bold, error, muted, selected])
    expect(format("Readable")).toBe("Readable");
});
