import { it, expect, vi } from "vitest";
import { MobilePairing } from "../apps/cli/src/mobile-pairing.ts";
const missing = () => Object.assign(Error("missing"), { code: "ENOENT" });
function fixture() {
  const panel = {
    prompt: vi
      .fn()
      .mockResolvedValueOnce("wss://relay.example")
      .mockResolvedValueOnce("secret"),
    choose: vi.fn().mockResolvedValue({ value: "allow" }),
  };
  const close = vi.fn();
  const view = {
    openModelPanel: vi.fn(() => ({ panel, close })),
    showPairing: vi.fn(),
    closePairing: vi.fn(),
    notice: vi.fn(),
    setError: vi.fn(),
  };
  const bridge = { close: vi.fn() };
  const deps = {
    readConfig: vi.fn().mockRejectedValue(missing()),
    pair: vi.fn().mockResolvedValue("hikaro://pair#fixture"),
    serve: vi.fn(async (_options: any) => bridge),
    qr: vi.fn().mockResolvedValue("QR"),
  };
  deps.pair.mockImplementation(async () => {
    deps.readConfig.mockResolvedValue({ registered: true } as never);
    return "hikaro://pair#fixture";
  });
  const mobile = new MobilePairing({ cwd: "/workspace", home: "/home" }, deps);
  return { mobile, view, panel, deps, bridge, close };
}
it("first pairing prompts privately, starts the bridge and displays code without auto-approving", async () => {
  const f = fixture();
  await f.mobile.pair(f.view as any);
  expect(f.panel.prompt.mock.calls[1]?.[1]).toBe(true);
  expect(f.deps.pair).toHaveBeenCalledWith({
    home: "/home",
    relay: "wss://relay.example",
    bootstrap: "secret",
  });
  expect(f.view.showPairing).toHaveBeenCalledWith(
    "hikaro://pair#fixture",
    "QR",
  );
  const approve = f.deps.serve.mock.calls[0]![0].approveDevice;
  expect(f.panel.choose).not.toHaveBeenCalled();
  expect(await approve("device-id")).toBe(true);
  expect(f.view.closePairing).toHaveBeenCalled();
  await f.mobile.close();
  expect(f.bridge.close).toHaveBeenCalledOnce();
});
it("existing configuration skips setup and reuses one bridge for repeated pairing", async () => {
  const f = fixture();
  f.deps.readConfig.mockResolvedValue({ registered: true } as never);
  await f.mobile.start(f.view as any);
  await f.mobile.pair(f.view as any);
  expect(f.panel.prompt).not.toHaveBeenCalled();
  expect(f.deps.serve).toHaveBeenCalledOnce();
  expect(f.deps.pair).toHaveBeenCalledWith({ home: "/home" });
});
it("cancelled setup creates no pairing and corrupt configuration is not overwritten", async () => {
  const f = fixture();
  f.panel.prompt
    .mockReset()
    .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
  await f.mobile.pair(f.view as any);
  expect(f.deps.pair).not.toHaveBeenCalled();
  f.deps.readConfig.mockRejectedValue(Error("invalid configuration"));
  await expect(f.mobile.pair(f.view as any)).rejects.toThrow(
    "invalid configuration",
  );
  expect(f.deps.pair).not.toHaveBeenCalled();
});
it("missing configuration on startup stays local and device confirmation defaults to refusal", async () => {
  const f = fixture();
  await f.mobile.start(f.view as any);
  expect(f.deps.serve).not.toHaveBeenCalled();
  await f.mobile.pair(f.view as any);
  f.panel.choose
    .mockReset()
    .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
  expect(await f.deps.serve.mock.calls[0]![0].approveDevice("device")).toBe(
    false,
  );
});
