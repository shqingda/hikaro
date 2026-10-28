import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";
import {
  keychainStore,
  readConfig,
} from "../packages/remote/src/host-store.ts";
import {
  createPairingInvite,
  acceptPairingClaim,
} from "../packages/remote/src/pairing-host.ts";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    homes.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "hikaro-invite-"));
  homes.push(home);
  const keys = new Map<string, string>();
  vi.spyOn(keychainStore, "set").mockImplementation(async (k, v) => {
    keys.set(k, v);
  });
  vi.spyOn(keychainStore, "get").mockImplementation(async (k) => keys.get(k));
  const requests: { url: string; body: any; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? JSON.parse(init.body) : undefined,
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json(
        url.endsWith("/pairings")
          ? { code: "012345", expires: Date.now() + 300000 }
          : { ok: true },
      );
    }),
  );
  return { home, requests };
}
it("creates a default invite without asking for bootstrap credentials or exporting private keys", async () => {
  const f = await setup();
  const uri = await createPairingInvite({ home: f.home });
  const invite = JSON.parse(decodeURIComponent(uri.split("#")[1]!));
  expect(invite).toMatchObject({
    code: "012345",
    v: 1,
    relay: "wss://hikaro-relay.shqingda.workers.dev",
  });
  expect(f.requests[0]?.url).toContain("/register");
  expect(
    f.requests.some((r) => JSON.stringify(r.body).includes("secretKey")),
  ).toBe(false);
  expect((await readConfig(f.home)).registered).toBe(true);
});
it("enrolls only a validated explicitly approved claim and preserves existing device entries", async () => {
  const f = await setup();
  await createPairingInvite({ home: f.home });
  const claim = {
    deviceId: randomToken(),
    publicKey: createIdentity().publicKey,
    token: randomToken(),
  };
  await acceptPairingClaim(f.home, claim);
  expect((await readConfig(f.home)).devices[claim.deviceId]).toMatchObject({
    publicKey: claim.publicKey,
    approved: true,
    expires: expect.any(Number),
  });
  expect(f.requests.at(-1)?.url).toContain("/enroll");
  expect(f.requests.some((r) => r.url.endsWith("/activate"))).toBe(false);
  await expect(
    acceptPairingClaim(f.home, { ...claim, publicKey: "bad" }),
  ).rejects.toThrow();
});
