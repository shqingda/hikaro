import nacl from "tweetnacl";
import {
  createIdentity,
  isRecord,
  isToken,
  publicKeyBytes,
  randomToken,
} from "../../crypto/src/index.ts";
import { parsePairing, validateRelay, validatePairing } from "./client.ts";
import { DEFAULT_RELAY } from "./defaults.ts";

/** Both screens compare the same ordered pair of public keys. */
export function pairingFingerprint(hostKey: string, publicKey: string): string {
  const bytes = new Uint8Array(64);
  bytes.set(publicKeyBytes(hostKey));
  bytes.set(publicKeyBytes(publicKey), 32);
  const hex = Array.from(nacl.hash(bytes).subarray(0, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return hex.slice(0, 4) + " " + hex.slice(4);
}
export type PairingWaiting = { fingerprint: string; expires: number };
type Options = {
  relay?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onWaiting?: (waiting: PairingWaiting) => void;
};
const cancelled = () => new DOMException("已取消配对", "AbortError");
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw cancelled();
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    checkAbort(signal);
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** The relay sees only public keys and bearer tokens, never the phone's key. */
export async function resolvePairing(
  input: string,
  options: Options = {},
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  let expired = false;
  let deadline = setTimeout(() => {
    expired = true;
    abort();
  }, 300000);
  try {
    checkAbort(signal);
    const value = input.trim();
    if (value.startsWith("hikaro://pair#")) {
      parsePairing(value);
      return value;
    }
    let relay = options.relay ?? DEFAULT_RELAY;
    let code = value;
    let pinnedKey: string | undefined;
    if (value.startsWith("hikaro://connect#")) {
      if (value.length > 4096) throw Error("二维码内容无效");
      const qr: unknown = JSON.parse(
        decodeURIComponent(value.slice("hikaro://connect#".length)),
      );
      if (
        !isRecord(qr) ||
        qr.v !== 1 ||
        typeof qr.code !== "string" ||
        typeof qr.hostKey !== "string"
      )
        throw Error("二维码内容无效");
      relay = validateRelay(qr.relay);
      code = qr.code;
      publicKeyBytes(qr.hostKey);
      pinnedKey = qr.hostKey;
    }
    if (!/^\d{6}$/.test(code)) throw Error("请输入电脑上显示的六位配对码");
    relay = validateRelay(relay);
    const base = relay.replace(/^wss:/, "https:") + "/pairings/" + code;
    const request = async (
      path = "",
      init: RequestInit = {},
    ): Promise<unknown> => {
      checkAbort(signal);
      const timer = setTimeout(abort, 15000);
      try {
        const response = await (options.fetch ?? globalThis.fetch)(
          base + path,
          {
            ...init,
            signal,
            redirect: "error",
          },
        );
        checkAbort(signal);
        if (!response.ok) {
          if (response.status === 404 || response.status === 410)
            throw Error("配对码不存在或已过期，请在电脑重新输入 /pair");
          if (response.status === 429) throw Error("尝试次数过多，请稍后再试");
          if (response.status === 409)
            throw Error("配对码已被使用，请在电脑重新输入 /pair");
          throw Error(`连接服务暂不可用（${response.status}），请重试`);
        }
        const data: unknown = await response.json();
        checkAbort(signal);
        return data;
      } finally {
        clearTimeout(timer);
      }
    };
    const metadata = await request();
    if (
      !isRecord(metadata) ||
      !isToken(metadata.hostId) ||
      typeof metadata.hostKey !== "string" ||
      typeof metadata.expires !== "number" ||
      !Number.isSafeInteger(metadata.expires)
    )
      throw Error("配对信息无效");
    publicKeyBytes(metadata.hostKey);
    if (pinnedKey && pinnedKey !== metadata.hostKey)
      throw Error("电脑公钥与二维码不一致，请重新扫码");
    if (
      metadata.expires <= Date.now() ||
      metadata.expires > Date.now() + 300000
    )
      throw Error("配对码已过期，请在电脑重新输入 /pair");
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      expired = true;
      abort();
    }, metadata.expires - Date.now());
    const identity = createIdentity(),
      deviceId = randomToken(),
      token = randomToken();
    await request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, publicKey: identity.publicKey, token }),
    });
    options.onWaiting?.({
      fingerprint: pairingFingerprint(metadata.hostKey, identity.publicKey),
      expires: metadata.expires,
    });
    for (;;) {
      const result = await request("/result", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (
        !isRecord(result) ||
        (result.approved !== null && typeof result.approved !== "boolean")
      )
        throw Error("配对状态无效");
      if (result.approved === false)
        throw Error("电脑已拒绝配对，请重新生成配对码后再试");
      if (result.approved) {
        const pairing = {
          v: 1,
          relay,
          hostId: metadata.hostId,
          hostKey: metadata.hostKey,
          expires: metadata.expires,
          identity,
          deviceId,
          token,
          ...(metadata.lan !== undefined ? { lan: metadata.lan } : {}),
        };
        validatePairing(pairing, true);
        return "hikaro://pair#" + encodeURIComponent(JSON.stringify(pairing));
      }
      await pause(signal);
    }
  } catch (error) {
    if (expired) throw Error("配对码已过期，请在电脑重新输入 /pair");
    if (signal.aborted && !options.signal?.aborted)
      throw Error("连接超时，请重试");
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
  }
}
