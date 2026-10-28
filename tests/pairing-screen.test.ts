import { it, expect, vi } from "vitest";
import { PairingScreen } from "../packages/tui/src/pairing-screen.ts";
import { serveRemote } from "../packages/remote/src/host.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("shows a complete QR or a resize instruction, with code and return keys", () => {
  const close = vi.fn(),
    refresh = vi.fn();
  const screen = new PairingScreen(
    "hikaro://pair#fixture",
    "████\n█  █\n████",
    () => 24,
    close,
    refresh,
  );
  expect(screen.render(80).join("\n")).toContain("████");
  expect(screen.render(3).join("\n")).toContain("请放大终端");
  expect(screen.render(3).join("\n")).not.toContain("████");
  screen.handleInput("\t");
  expect(screen.render(80).join("\n")).toContain("hikaro://pair#fixture");
  screen.handleInput("\x1b");
  expect(close).toHaveBeenCalledOnce();
});
it("legacy serve without pairing explains the TUI entry instead of ENOENT", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-no-pair-"));
  try {
    await expect(serveRemote({ home, cwd: home })).rejects.toThrow("/pair");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("never displays a silently truncated pairing credential", () => {
  const screen = new PairingScreen(
    "hikaro://pair#" + "x".repeat(1000),
    "QR",
    () => 8,
    () => {},
    () => {},
  );
  screen.handleInput("\t");
  const output = screen.render(40).join("\n");
  expect(output).toContain("完整显示配对码");
  expect(output).not.toContain("hikaro://pair#");
});

it("always shows the six-digit code even when the QR cannot fit", () => {
  const uri =
    "hikaro://connect#" +
    encodeURIComponent(JSON.stringify({ code: "012345" }));
  const screen = new PairingScreen(
    uri,
    "█".repeat(100),
    () => 8,
    () => {},
    () => {},
  );
  expect(screen.render(40).join("\n")).toContain("配对码 012345");
  expect(screen.render(40).join("\n")).toContain("请放大终端");
  screen.handleInput("\t");
  expect(screen.render(80).join("\n")).toContain("012345");
});
