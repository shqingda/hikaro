import { homedir } from "node:os";
import { join } from "node:path";
import {
  createIdentity,
  randomToken,
  isToken,
  isRecord,
  publicKeyBytes,
} from "../../crypto/src/index.ts";
import { validateRelay } from "./client.ts";
import { DEFAULT_RELAY } from "./defaults.ts";
import {
  loadHost,
  keychainStore,
  writeConfig,
  withConfigLock,
  type HostConfig,
} from "./host-store.ts";

export type PairingClaim = {
  deviceId: string;
  publicKey: string;
  token: string;
};
export function validateClaim(value: unknown): asserts value is PairingClaim {
  if (!isRecord(value) || !isToken(value.deviceId) || !isToken(value.token))
    throw Error("Invalid pairing request");
  publicKeyBytes(value.publicKey);
}
export async function pairingRequest(
  home: string | undefined,
  path: string,
  data?: unknown,
  signal?: AbortSignal,
) {
  const { config, secret } = await loadHost(home ?? join(homedir(), ".hikaro"));
  const response = await fetch(
    validateRelay(config.relay).replace(/^wss:/, "https:") + path,
    {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${secret.token}`,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw Error(`手机配对请求失败（${response.status}），请重新输入 /pair。`);
  return response.json() as Promise<unknown>;
}
export async function createPairingInvite(options: {
  home?: string;
  relay?: string;
  lan?: string[];
}) {
  const home = options.home ?? join(homedir(), ".hikaro");
  await withConfigLock(home, async () => {
    let config: HostConfig;
    try {
      ({ config } = await loadHost(home));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const identity = createIdentity();
      config = {
        relay: validateRelay(options.relay ?? DEFAULT_RELAY),
        hostId: randomToken(),
        publicKey: identity.publicKey,
        registered: false,
        devices: {},
      };
      await keychainStore.set(
        `host:${config.hostId}`,
        JSON.stringify({ identity, token: randomToken() }),
      );
      await writeConfig(home, config);
    }
    if (config.registered === false) {
      const { secret } = await loadHost(home);
      await pairingRequest(home, `/hosts/${config.hostId}/register`, {
        token: secret.token,
      });
      config.registered = true;
      await writeConfig(home, config);
    }
  });
  const { config } = await loadHost(home);
  const result = await pairingRequest(home, "/pairings", {
    hostId: config.hostId,
    hostKey: config.publicKey,
    expires: Date.now() + 300000,
    ...(options.lan?.length ? { lan: options.lan } : {}),
  });
  if (
    !isRecord(result) ||
    typeof result.code !== "string" ||
    !/^\d{6}$/.test(result.code) ||
    typeof result.expires !== "number" ||
    result.expires <= Date.now()
  )
    throw Error("Invalid pairing invitation");
  return (
    "hikaro://connect#" +
    encodeURIComponent(
      JSON.stringify({
        v: 1,
        relay: config.relay,
        code: result.code,
        hostKey: config.publicKey,
      }),
    )
  );
}
/** Called only after the desktop user explicitly approves this public key. */
export async function acceptPairingClaim(
  home: string | undefined,
  claim: PairingClaim,
) {
  validateClaim(claim);
  const dir = home ?? join(homedir(), ".hikaro");
  await withConfigLock(dir, async () => {
    const { config } = await loadHost(dir);
    for (const [id, device] of Object.entries(config.devices))
      if (device.expires !== undefined && device.expires <= Date.now())
        delete config.devices[id];
    if (
      Object.keys(config.devices).length >= 32 &&
      !config.devices[claim.deviceId]
    )
      throw Error("请先撤销一台旧设备，再连接新手机。");
    await pairingRequest(dir, `/hosts/${config.hostId}/enroll`, {
      id: claim.deviceId,
      token: claim.token,
    });
    config.devices[claim.deviceId] = {
      publicKey: claim.publicKey,
      expires: Date.now() + 300000,
      approved: true,
    };
    await writeConfig(dir, config);
  });
}
