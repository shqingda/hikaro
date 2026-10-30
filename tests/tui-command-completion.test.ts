import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { FileAutocompleteProvider } from "../packages/tui/src/file-autocomplete.ts";
import { HikaroView } from "../packages/tui/src/index.ts";

it("shows one command and uses the overriding definition for argument completion", async () => {
  const override = vi.fn(async () => [{ value: "control", label: "Control" }]);
  const provider = new FileAutocompleteProvider(
    [
      { name: "permissions", description: "Workspace approval policy" },
      { value: "help", label: "Show help" },
      {
        name: "permissions",
        description: "Open permissions",
        getArgumentCompletions: override,
      },
      { name: "help", description: "Show commands" },
    ],
    process.cwd(),
  );
  const options = { signal: new AbortController().signal };
  const result = await provider.getSuggestions(["/per"], 0, 4, options);
  expect(result?.items).toEqual([
    {
      value: "permissions",
      label: "permissions",
      description: "Open permissions",
    },
  ]);
  expect(
    (await provider.getSuggestions(["/help"], 0, 5, options))?.items,
  ).toHaveLength(1);
  expect(
    (await provider.getSuggestions(["/permissions c"], 0, 14, options))?.items,
  ).toEqual([{ value: "control", label: "Control" }]);
  expect(override).toHaveBeenCalledWith("c");
});

it("renders one permissions suggestion in attached views and keeps completion from submitting", async () => {
  const terminal: Terminal = {
    rows: 30,
    columns: 100,
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
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const onCommand = vi.fn(async () => {});
  const view = new HikaroView(tui, {
    cwd: process.cwd(),
    model: "shared host",
    onPrompt: async () => {},
    onCommand,
    onExit: () => {},
    commands: [{ name: "permissions", description: "Open permissions" }],
  });
  tui.setFocus(view.editor);
  const screen = () =>
    stripVTControlCharacters(view.editor.render(100).join("\n"));
  try {
    view.editor.handleInput("/per");
    await vi.waitFor(() => expect(screen()).toContain("Open permissions"));
    expect(screen().match(/permissions/g)).toHaveLength(2); // command and description in one row
    expect(screen()).not.toContain("Workspace approval policy");
    view.editor.handleInput("\t");
    expect(view.editor.getText()).toBe("/permissions ");
    expect(onCommand).not.toHaveBeenCalled();
  } finally {
    view.dispose();
  }
});
