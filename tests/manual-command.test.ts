import { expect, it } from "vitest";
import { parseManualCommand } from "../packages/tui/src/manual-command.ts";
it("requires an explicit standalone flag for unrestricted manual shell access", () => {
  expect(parseManualCommand("!printf --unrestricted")).toEqual({
    command: "printf --unrestricted",
    unrestricted: false,
  });
  expect(parseManualCommand("! --unrestricted printf proof")).toEqual({
    command: "printf proof",
    unrestricted: true,
  });
  expect(parseManualCommand("!--unrestricted-name")).toEqual({
    command: "--unrestricted-name",
    unrestricted: false,
  });
  expect(() => parseManualCommand("! --unrestricted")).toThrow(/COMMAND/);
});
