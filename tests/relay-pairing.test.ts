import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { randomToken, createIdentity } from "../packages/crypto/src/index.ts";
import {
  createPairingInvite,
  acceptPairingClaim,
  pairingRequest,
  validateClaim,
} from "../packages/remote/src/pairing-host.ts";
import { resolvePairing } from "../packages/remote/src/pairing-client.ts";
import { parsePairing } from "../packages/remote/src/client.ts";
import {
  keychainStore,
  readConfig,
} from "../packages/remote/src/host-store.ts";

const require = createRequire(import.meta.url);
const relayRequire = createRequire(resolve("apps/relay/package.json"));
const wranglerRequire = createRequire(
  relayRequire.resolve("wrangler/package.json"),
);
async function fixture(publicRegistration = true) {
  const { Miniflare, convertV4MiniflareOptions } = require(
    wranglerRequire.resolve("miniflare"),
  );
  const built = await build({
    entryPoints: ["apps/relay/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const bootstrap = randomToken();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: built.outputFiles![0]!.text,
      compatibilityDate: "2026-10-01",
      durableObjects: {
        HOSTS: { className: "HostRelay", useSQLite: true },
        PAIRINGS: { className: "PairingRegistry", useSQLite: true },
      },
      bindings: {
        BOOTSTRAP_TOKEN: bootstrap,
        PUBLIC_REGISTRATION: String(publicRegistration),
      },
      queueProducers: { NOTIFICATIONS: "notifications" },
    }),
  );
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    token?: string,
    ip = "192.0.2.1",
  ) =>
    mf.dispatchFetch("https://relay.example" + path, {
      method,
      headers: {
        "CF-Connecting-IP": ip,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const hostId = randomToken(),
    hostToken = randomToken(),
    hostKey = createIdentity().publicKey;
  const register = () =>
    request(
      `/hosts/${hostId}/register`,
      "POST",
      { token: hostToken },
      publicRegistration ? undefined : bootstrap,
    );
  const create = (expires = Date.now() + 300000) =>
    request("/pairings", "POST", { hostId, hostKey, expires }, hostToken);
  return { mf, request, hostId, hostToken, hostKey, register, create };
}

it("registers without an administrator secret only when enabled and cannot replace host ownership", async () => {
  const f = await fixture();
  try {
    expect((await f.register()).status).toBe(200);
    expect((await f.register()).status).toBe(200);
    expect(
      (
        await f.request(`/hosts/${f.hostId}/register`, "POST", {
          token: randomToken(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          `/hosts/${f.hostId}/host-auth`,
          "GET",
          undefined,
          f.hostToken,
        )
      ).status,
    ).toBe(200);
    expect((await f.request(`/hosts/${f.hostId}/host-auth`)).status).toBe(401);
  } finally {
    await f.mf.dispose();
  }
  const legacy = await fixture(false);
  try {
    expect(
      (
        await legacy.request(`/hosts/${legacy.hostId}/register`, "POST", {
          token: legacy.hostToken,
        })
      ).status,
    ).toBe(401);
    expect((await legacy.register()).status).toBe(200);
  } finally {
    await legacy.mf.dispose();
  }
});

it("pairs one claimant with host authorization without exposing the claimant token to lookup", async () => {
  const f = await fixture();
  try {
    await f.register();
    expect(
      (
        await f.request(
          "/pairings",
          "POST",
          {
            hostId: f.hostId,
            hostKey: f.hostKey,
            expires: Date.now() + 300000,
          },
          randomToken(),
        )
      ).status,
    ).toBe(401);
    const created = await f.create();
    expect(created.status).toBe(200);
    const { code, expires } = await created.json();
    expect(code).toMatch(/^\d{6}$/);
    const path = `/pairings/${code}`;
    const publicInfo = await f.request(path);
    expect(publicInfo.headers.get("Cache-Control")).toBe("no-store");
    expect(await publicInfo.json()).toEqual({
      hostId: f.hostId,
      hostKey: f.hostKey,
      expires,
    });
    expect(
      await (
        await f.request(path + "/request", "GET", undefined, f.hostToken)
      ).json(),
    ).toBe(null);
    const claim = {
      deviceId: randomToken(),
      publicKey: createIdentity().publicKey,
      token: randomToken(),
    };
    expect((await f.request(path + "/claim", "POST", claim)).status).toBe(200);
    expect((await f.request(path + "/claim", "POST", claim)).status).toBe(200);
    expect(
      (
        await f.request(path + "/claim", "POST", {
          ...claim,
          token: randomToken(),
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.request(path + "/request", "GET", undefined, randomToken()))
        .status,
    ).toBe(401);
    const otherHost = randomToken(),
      otherToken = randomToken();
    await f.request(`/hosts/${otherHost}/register`, "POST", {
      token: otherToken,
    });
    expect(
      (await f.request(path + "/request", "GET", undefined, otherToken)).status,
    ).toBe(401);
    expect(
      await (
        await f.request(path + "/request", "GET", undefined, f.hostToken)
      ).json(),
    ).toEqual(claim);
    expect(
      (await f.request(path + "/result", "GET", undefined, randomToken()))
        .status,
    ).toBe(401);
    expect(
      await (
        await f.request(path + "/result", "GET", undefined, claim.token)
      ).json(),
    ).toEqual({ approved: null });
    expect(
      (
        await f.request(
          path + "/complete",
          "POST",
          { deviceId: claim.deviceId, approved: true },
          randomToken(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          path + "/complete",
          "POST",
          { deviceId: randomToken(), approved: true },
          f.hostToken,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          path + "/complete",
          "POST",
          { deviceId: claim.deviceId, approved: true },
          f.hostToken,
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await f.request(path + "/result", "GET", undefined, claim.token)
      ).json(),
    ).toEqual({ approved: true });
    expect(
      (
        await f.request(
          path + "/complete",
          "POST",
          { deviceId: claim.deviceId, approved: false },
          f.hostToken,
        )
      ).status,
    ).toBe(409);
  } finally {
    await f.mf.dispose();
  }
});

it("invalidates previous codes and expires enrollment without extending the requested lifetime", async () => {
  const f = await fixture();
  try {
    await f.register();
    expect((await f.create(Date.now() - 1)).status).toBe(400);
    expect((await f.create(Date.now() + 600001)).status).toBe(400);
    const old = await (await f.create()).json();
    const next = await (await f.create(Date.now() + 400)).json();
    expect((await f.request(`/pairings/${old.code}`)).status).toBe(410);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect((await f.request(`/pairings/${next.code}`)).status).toBe(410);
  } finally {
    await f.mf.dispose();
  }
});

it("limits six-digit guesses per IP without blocking another client", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 30; i++)
      expect((await f.request("/pairings/000000")).status).toBe(410);
    expect((await f.request("/pairings/000000")).status).toBe(429);
    expect(
      (
        await f.request(
          "/pairings/000000",
          "GET",
          undefined,
          undefined,
          "192.0.2.2",
        )
      ).status,
    ).toBe(410);
  } finally {
    await f.mf.dispose();
  }
});

it("carries only private LAN WebSocket origins in pairing metadata", async () => {
  const f = await fixture();
  try {
    await f.register();
    const create = (lan: string[]) =>
      f.request(
        "/pairings",
        "POST",
        {
          hostId: f.hostId,
          hostKey: f.hostKey,
          expires: Date.now() + 300000,
          lan,
        },
        f.hostToken,
      );
    for (const invalid of [
      "ws://8.8.8.8:1234",
      "ws://127.0.0.1:1234",
      "ws://192.168.1.2:1234/path",
      "https://192.168.1.2:1234",
    ])
      expect((await create([invalid])).status).toBe(400);
    const lan = [
      "ws://192.168.1.2:1234",
      "ws://10.0.0.2:1234",
      "ws://172.16.1.1:1234",
    ];
    const { code } = await (await create(lan)).json();
    expect(await (await f.request(`/pairings/${code}`)).json()).toMatchObject({
      lan,
    });
  } finally {
    await f.mf.dispose();
  }
});

it("limits open registration before allocating unlimited host records", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.request(`/hosts/${randomToken()}/register`, "POST", {
            token: randomToken(),
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await f.request(`/hosts/${randomToken()}/register`, "POST", {
          token: randomToken(),
        })
      ).status,
    ).toBe(429);
    expect((await f.request("/internal/register-limit", "POST")).status).toBe(
      404,
    );
  } finally {
    await f.mf.dispose();
  }
});

it("joins desktop and mobile through the real relay without transmitting a private key", async () => {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), "hikaro-relay-pairing-"));
  const keys = new Map<string, string>();
  const requests: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.body) requests.push(String(init.body));
    return f.mf.dispatchFetch("https://relay.example" + url.pathname, init);
  };
  vi.spyOn(keychainStore, "get").mockImplementation(async (key) =>
    keys.get(key),
  );
  vi.spyOn(keychainStore, "set").mockImplementation(async (key, value) => {
    keys.set(key, value);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(transport);
  const abort = new AbortController();
  let phone: Promise<string> | undefined;
  try {
    const invitation = await createPairingInvite({
      home,
      relay: "wss://relay.example",
      lan: ["ws://192.168.1.2:1234"],
    });
    const data = JSON.parse(decodeURIComponent(invitation.split("#")[1]!));
    let waiting!: () => void;
    const claimed = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    phone = resolvePairing(invitation, {
      fetch: transport,
      signal: abort.signal,
      onWaiting: waiting,
    });
    await claimed;
    const claim = await pairingRequest(home, `/pairings/${data.code}/request`);
    validateClaim(claim);
    await acceptPairingClaim(home, claim);
    await pairingRequest(home, `/pairings/${data.code}/complete`, {
      deviceId: claim.deviceId,
      approved: true,
    });
    const result = parsePairing(await phone);
    expect(result).toMatchObject({
      hostKey: data.hostKey,
      deviceId: claim.deviceId,
      token: claim.token,
      lan: ["ws://192.168.1.2:1234"],
    });
    expect(result.identity.publicKey).toBe(claim.publicKey);
    expect((await readConfig(home)).devices[claim.deviceId]?.publicKey).toBe(
      result.identity.publicKey,
    );
    expect(
      requests.some(
        (text) =>
          text.includes("secretKey") ||
          text.includes(result.identity.secretKey),
      ),
    ).toBe(false);
  } finally {
    abort.abort();
    await phone?.catch(() => {});
    vi.restoreAllMocks();
    await f.mf.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
