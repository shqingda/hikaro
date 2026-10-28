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
    lanOrigins: () => [],
    readConfig: vi.fn().mockRejectedValue(missing()),
    request: vi.fn().mockResolvedValue(null),
    accept: vi.fn(),
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
it("first pairing uses default service without prompts and does not auto-approve", async () => {
  const f = fixture();
  await f.mobile.pair(f.view as any);
  expect(f.panel.prompt).not.toHaveBeenCalled();
  expect(f.deps.pair).toHaveBeenCalledWith({
    home: "/home",
    lan: [],
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
  expect(f.deps.pair).toHaveBeenCalledWith({ home: "/home", lan: [] });
});
it("corrupt configuration is not overwritten", async () => {
  const f = fixture();
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

it("waits for explicit fingerprint approval before accepting a short-code claim", async () => {
  const { createIdentity, randomToken } =
    await import("../packages/crypto/src/index.ts");
  const f = fixture();
  const hostKey = createIdentity().publicKey;
  const claim = {
    deviceId: randomToken(),
    publicKey: createIdentity().publicKey,
    token: randomToken(),
  };
  f.deps.readConfig.mockResolvedValue({ registered: true } as never);
  f.deps.request.mockResolvedValue(claim as never);
  const uri =
    "hikaro://connect#" +
    encodeURIComponent(JSON.stringify({ code: "012345", hostKey }));
  try {
    await f.mobile.show(f.view as any, uri);
    await vi.waitFor(() =>
      expect(f.deps.accept).toHaveBeenCalledWith("/home", claim),
    );
    expect(f.panel.choose.mock.calls[0]?.[0]).toBe("确认连接手机");
    expect(f.deps.request).toHaveBeenCalledWith(
      "/home",
      "/pairings/012345/complete",
      { deviceId: claim.deviceId, approved: true },
      expect.any(AbortSignal),
    );
  } finally {
    await f.mobile.close();
  }
});

it("does not enroll an invitation that expired while its approval panel was open", async () => {
  const { createIdentity, randomToken } =
    await import("../packages/crypto/src/index.ts");
  const f = fixture();
  f.deps.readConfig.mockResolvedValue({ registered: true } as never);
  f.deps.request
    .mockResolvedValueOnce({
      deviceId: randomToken(),
      publicKey: createIdentity().publicKey,
      token: randomToken(),
    } as never)
    .mockRejectedValueOnce(Error("expired"));
  const uri =
    "hikaro://connect#" +
    encodeURIComponent(
      JSON.stringify({ code: "012345", hostKey: createIdentity().publicKey }),
    );
  try {
    await f.mobile.show(f.view as any, uri);
    await vi.waitFor(() =>
      expect(f.view.setError).toHaveBeenCalledWith("Error: expired"),
    );
    expect(f.deps.accept).not.toHaveBeenCalled();
  } finally {
    await f.mobile.close();
  }
});
