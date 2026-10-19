import { it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { launchSimulator, DEVICE } from "../scripts/dev-sim.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
function fixture(owner = true, device = DEVICE, available = true) {
  const io = {
    log: vi.fn(),
    pause: async () => {},
    start: vi.fn(),
    readPreview: async () => ({ device, port: 3200, pid: 123 }),
    fetchText: async (url: string) =>
      url.endsWith("/status")
        ? "packager-status:running"
        : "<title>Simulator Preview</title>",
    run: vi.fn(async (command: string, args: string[]) => {
      const text = args.join(" ");
      if (text === "simctl list devices --json")
        return JSON.stringify({
          devices: {
            ios: available
              ? [{ udid: DEVICE, state: "Booted", isAvailable: true }]
              : [],
          },
        });
      if (command === "lsof")
        return args.includes("-Fn")
          ? `n${owner ? root : "/another-project"}/apps/mobile`
          : "123";
      if (args.includes("notifyutil"))
        return "com.apple.coredevice.dtuhidd.active 0";
      if (command === "ps") return `serve-sim ${DEVICE}`;
      return "";
    }),
  };
  return io;
}
it("reuses the original simulator and opens only the browser without creating or changing devices", async () => {
  const io = fixture();
  await launchSimulator(io);
  expect(io.start).not.toHaveBeenCalled();
  expect(
    io.run.mock.calls.some(([, args]) =>
      [
        "create",
        "clone",
        "erase",
        "delete",
        "keychain",
        "install",
        "repair-input",
      ].some((action) => args.includes(action)),
    ),
  ).toBe(false);
  expect(
    io.run.mock.calls.some(([, args]) =>
      args.some((a) =>
        a.startsWith("hikaro-companion://expo-development-client/"),
      ),
    ),
  ).toBe(true);
  expect(io.run.mock.calls.filter(([command]) => command === "open")).toEqual([
    ["open", ["http://localhost:3200/"]],
  ]);
});
it("refuses a missing selected device without creating a replacement", async () => {
  const io = fixture(true, DEVICE, false);
  await expect(launchSimulator(io)).rejects.toThrow(/不存在或不可用/);
  expect(io.start).not.toHaveBeenCalled();
  expect(
    io.run.mock.calls.some(
      ([, args]) => args.includes("create") || args.includes("clone"),
    ),
  ).toBe(false);
});
it("refuses another project's Metro before starting or stopping services", async () => {
  const io = fixture(false);
  await expect(launchSimulator(io)).rejects.toThrow(/不属于当前项目/);
  expect(io.start).not.toHaveBeenCalled();
  expect(io.run.mock.calls.some(([command]) => command === "kill")).toBe(false);
});
it("refuses an unrelated preview without killing its process", async () => {
  const io = fixture(true, "another-device");
  await expect(launchSimulator(io)).rejects.toThrow(/3200/);
  expect(io.start).not.toHaveBeenCalled();
  expect(io.run.mock.calls.some(([command]) => command === "kill")).toBe(false);
});
