import { it, expect, vi } from "vitest";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";
import { parsePairing } from "../packages/remote/src/client.ts";
import {
  resolvePairing,
  pairingFingerprint,
} from "../packages/remote/src/pairing-client.ts";

const host = createIdentity();
function fixture(approved: boolean | null = true) {
  const metadata = {
    hostId: randomToken(),
    hostKey: host.publicKey,
    expires: Date.now() + 60000,
  };
  let claim: any;
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/claim")) {
        claim = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }
      if (String(url).endsWith("/result")) return Response.json({ approved });
      return Response.json(metadata);
    },
  );
  return { metadata, fetcher, claim: () => claim };
}
it("resolves a six-digit code using phone-owned identity and sends no private key", async () => {
  const f = fixture();
  const waiting = vi.fn();
  const uri = await resolvePairing("012345", {
    relay: "wss://relay.example",
    fetch: f.fetcher,
    onWaiting: waiting,
  });
  const pairing = parsePairing(uri);
  expect(pairing.hostId).toBe(f.metadata.hostId);
  expect(pairing.identity.publicKey).toBe(f.claim().publicKey);
  expect(f.claim()).toEqual({
    deviceId: pairing.deviceId,
    token: pairing.token,
    publicKey: pairing.identity.publicKey,
  });
  expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain(
    pairing.identity.secretKey,
  );
  expect(waiting).toHaveBeenCalledWith({
    fingerprint: pairingFingerprint(host.publicKey, pairing.identity.publicKey),
    expires: f.metadata.expires,
  });
  expect(f.fetcher.mock.calls[2]?.[1]?.headers).toEqual({
    Authorization: `Bearer ${pairing.token}`,
  });
});
it("pins the QR host key before sending a claim", async () => {
  const f = fixture();
  const qr =
    "hikaro://connect#" +
    encodeURIComponent(
      JSON.stringify({
        v: 1,
        relay: "wss://relay.example",
        code: "012345",
        hostKey: createIdentity().publicKey,
      }),
    );
  await expect(resolvePairing(qr, { fetch: f.fetcher })).rejects.toThrow(
    "公钥",
  );
  expect(f.claim()).toBeUndefined();
});
it("accepts a valid pinned QR and preserves legacy QR compatibility", async () => {
  const f = fixture();
  const qr =
    "hikaro://connect#" +
    encodeURIComponent(
      JSON.stringify({
        v: 1,
        relay: "wss://relay.example",
        code: "012345",
        hostKey: host.publicKey,
      }),
    );
  const uri = await resolvePairing(qr, { fetch: f.fetcher });
  expect(
    await resolvePairing(uri, {
      fetch: vi.fn(() => {
        throw Error("unexpected fetch");
      }),
    }),
  ).toBe(uri);
});
it("rejects expired codes and explicit host refusal", async () => {
  const f = fixture();
  f.metadata.expires = Date.now() - 1;
  await expect(
    resolvePairing("012345", {
      relay: "wss://relay.example",
      fetch: f.fetcher,
    }),
  ).rejects.toThrow("过期");
  const denied = fixture(false);
  await expect(
    resolvePairing("012345", {
      relay: "wss://relay.example",
      fetch: denied.fetcher,
    }),
  ).rejects.toThrow("拒绝");
});
it("cancels while waiting without returning pairing credentials", async () => {
  const f = fixture(null);
  const abort = new AbortController();
  const result = resolvePairing("012345", {
    relay: "wss://relay.example",
    fetch: f.fetcher,
    signal: abort.signal,
    onWaiting: () => abort.abort(),
  });
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
it("rejects malformed input without contacting the relay", async () => {
  const f = fixture();
  await expect(resolvePairing("12345", { fetch: f.fetcher })).rejects.toThrow(
    "六位",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("polls until approval and retains validated LAN hints", async () => {
  const f = fixture();
  Object.assign(f.metadata, { lan: ["ws://192.168.1.5:49152"] });
  const original = f.fetcher.getMockImplementation()!;
  let results = 0;
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/result") && results++ === 0)
      return Response.json({ approved: null });
    return original(url, init);
  });
  const pairing = parsePairing(
    await resolvePairing("012345", {
      relay: "wss://relay.example",
      fetch: f.fetcher,
    }),
  );
  expect(pairing.lan).toEqual(["ws://192.168.1.5:49152"]);
  expect(results).toBe(2);
});
it("expires while waiting for computer confirmation", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(null);
    f.metadata.expires = Date.now() + 2000;
    const result = resolvePairing("012345", {
      relay: "wss://relay.example",
      fetch: f.fetcher,
    });
    const rejected = expect(result).rejects.toThrow("过期");
    await vi.advanceTimersByTimeAsync(2100);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});
it("does not save an unrecognized approval response", async () => {
  const f = fixture();
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((url, init) =>
    String(url).endsWith("/result")
      ? Promise.resolve(Response.json({ approved: "yes" }))
      : original(url, init),
  );
  await expect(
    resolvePairing("012345", {
      relay: "wss://relay.example",
      fetch: f.fetcher,
    }),
  ).rejects.toThrow("状态无效");
});
