import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  commandCompletions,
  commandHelp,
  commandSpecs,
  parseCommand,
  type CommandMode,
} from "../packages/tui/src/commands.ts";

// HikaroView answers these itself in every mode.
const viewCommands = new Set([
  "follow",
  "tools",
  "older",
  "newer",
  "latest",
  "read",
]);

const source = (...paths: string[]) =>
  paths.map((path) => readFileSync(path, "utf8")).join("\n");

const dispatchers: Record<
  Exclude<CommandMode, "pi">,
  { text: string; handles: (name: string) => boolean }
> = {
  native: {
    text: source("packages/cli/src/native-tui.ts"),
    handles(name) {
      return this.text.includes(`case "${name}"`);
    },
  },
  attached: {
    text: source(
      "packages/cli/src/attached-tui.ts",
      "packages/cli/src/attached-workflows.ts",
    ),
    handles(name) {
      return this.text.includes(`case "/${name}"`);
    },
  },
};

it.each(["native", "attached"] as const)(
  "routes every %s registry command to a handler, never to plugins",
  (mode) => {
    const missing = commandSpecs
      .filter((spec) => (spec.modes as readonly string[]).includes(mode))
      .map((spec) => spec.name)
      .filter((name) => !viewCommands.has(name))
      .filter((name) => !dispatchers[mode].handles(name));
    expect(missing).toEqual([]);
  },
);

it("keeps completion and help on the same per-mode list", () => {
  for (const mode of ["native", "attached", "pi"] as const) {
    const help = commandHelp(mode);
    for (const { name } of commandCompletions(mode))
      expect(help).toContain(`/${name}`);
  }
  expect(commandHelp("native")).toContain("/questions");
  expect(commandHelp("attached")).not.toContain("/questions");
  expect(commandHelp("attached")).toContain("/delete");
  expect(commandHelp("pi")).not.toContain("/sessions");
  expect(commandCompletions("native").map((c) => c.name)).not.toContain(
    "login",
  );
});

it("parses names and arguments without the slash", () => {
  expect(parseCommand("/model  demo/fast ")).toEqual({
    name: "model",
    arg: "demo/fast",
  });
  expect(parseCommand("/help")).toEqual({ name: "help", arg: "" });
});
