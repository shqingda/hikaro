import { readFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isRecord,
  isToken,
  publicKeyBytes,
  validateIdentity,
  type Identity,
} from "../../crypto/src/index.ts";
import { validateRelay } from "./client.ts";

export type HostConfig = {
  relay: string;
  hostId: string;
  publicKey: string;
  registered?: boolean;
  devices: Record<string, { publicKey: string; expires?: number }>;
  pendingRevocations?: string[];
};
export type HostSecret = { identity: Identity; token: string };
export interface SecretStore {
  get(account: string): Promise<string | null | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<unknown>;
}
// Load native Keychain code only when the real store is used, never in tests.
export const keychainStore: SecretStore = {
  async get(account) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("hikaro", account).getPassword();
  },
  async set(account, value) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry("hikaro", account).setPassword(value);
  },
  async delete(account) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("hikaro", account).deletePassword();
  },
};
export async function readConfig(home: string): Promise<HostConfig> {
  const file = join(home, "remote.json");
  if ((await stat(file)).size > 65536)
    throw Error("Host configuration is too large");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    !isRecord(value) ||
    !isToken(value.hostId) ||
    !isRecord(value.devices) ||
    Object.keys(value.devices).length > 32 ||
    (value.registered !== undefined && typeof value.registered !== "boolean")
  )
    throw Error("Invalid host configuration");
  validateRelay(value.relay);
  publicKeyBytes(value.publicKey);
  for (const [id, device] of Object.entries(value.devices)) {
    if (
      !isToken(id) ||
      !isRecord(device) ||
      (device.expires !== undefined &&
        (typeof device.expires !== "number" ||
          !Number.isSafeInteger(device.expires) ||
          device.expires <= 0))
    )
      throw Error("Invalid device configuration");
    publicKeyBytes(device.publicKey);
  }
  if (
    value.pendingRevocations !== undefined &&
    (!Array.isArray(value.pendingRevocations) ||
      value.pendingRevocations.length > 64 ||
      !value.pendingRevocations.every(isToken))
  )
    throw Error("Invalid revocation configuration");
  return value as HostConfig;
}
export async function loadHost(
  home: string,
  secrets: SecretStore = keychainStore,
) {
  const config = await readConfig(home);
  const value = await secrets.get("host:" + config.hostId);
  if (!value)
    throw Error(
      "Host key missing from Keychain; restore the original key or reset remote setup explicitly",
    );
  const secret: unknown = JSON.parse(value);
  if (!isRecord(secret) || !isToken(secret.token))
    throw Error("Invalid host secret");
  validateIdentity(secret.identity);
  if (secret.identity.publicKey !== config.publicKey)
    throw Error("Host Keychain identity does not match configuration");
  return { config, secret: secret as HostSecret };
}
export async function writeConfig(home: string, config: HostConfig) {
  const temp = join(home, ".remote-" + randomUUID() + ".tmp");
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(config, null, 2));
    await file.sync();
    await file.close();
    await rename(temp, join(home, "remote.json"));
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close().catch(() => {});
    await rm(temp, { force: true });
  }
}
/** One lock covers read-modify-write across serve, pair, and revoke processes. */
export async function withConfigLock<T>(
  home: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, ".remote.lock");
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = Number(await readFile(join(lock, "pid"), "utf8"));
        if (Number.isSafeInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (e) {
            stale = (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        stale =
          Date.now() -
            (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs >
          30000;
      }
      if (stale) {
        const abandoned = lock + "." + randomUUID();
        try {
          await rename(lock, abandoned);
          await rm(abandoned, { recursive: true, force: true });
        } catch {
          /* Another process recovered it. */
        }
      }
      if (Date.now() - start > 20000)
        throw Error("Remote configuration is locked by another process");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  try {
    const owner = await open(join(lock, "pid"), "wx", 0o600);
    try {
      await owner.writeFile(String(process.pid));
    } finally {
      await owner.close();
    }
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
