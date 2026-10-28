import * as Crypto from "expo-crypto";
import { fetch } from "expo/fetch";
import { setRandomSource } from "../../../packages/crypto/src/index";
import { MobileController } from "./controller";
import { nativeStorage } from "./native-storage";
import {
  validateRelay,
  validateLan,
  type Pairing,
} from "../../../packages/remote/src/client";
export async function probePairing(p: Pairing) {
  for (const origin of p.lan ?? []) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 1500);
    try {
      // LAN never receives the relay bearer token. SecureChannel proves identity after dialing.
      const response = await fetch(
        validateLan(origin).replace(/^ws:/, "http:") +
          `/hosts/${p.hostId}/device-status/${p.deviceId}`,
        { signal: controller.signal, redirect: "error" },
      );
      if (response.ok) {
        const status = await response.json();
        if (status?.hostOnline === true && status?.confirmed === true)
          return "ready" as const;
      }
    } catch {
      /* A changed Wi-Fi address falls through to the relay. */
    } finally {
      clearTimeout(deadline);
    }
  }
  return probeRelay(p);
}
async function probeRelay(p: Pairing) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      validateRelay(p.relay).replace(/^wss:/, "https:") +
        `/hosts/${p.hostId}/device-status/${p.deviceId}`,
      {
        headers: { Authorization: `Bearer ${p.token}` },
        signal: controller.signal,
        redirect: "error",
      },
    );
    if (response.status === 401 || response.status === 403)
      return "revoked" as const;
    if (!response.ok) throw Error("Relay status unavailable");
    const size = response.headers.get("content-length");
    if (size !== null && Number(size) > 4096)
      throw Error("Invalid relay status");
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let length = 0;
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          length += value.value.byteLength;
          if (length > 4096) {
            await reader.cancel();
            throw Error("Invalid relay status");
          }
          text += decoder.decode(value.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    } else throw Error("Invalid relay status stream");
    const value = JSON.parse(text);
    if (
      typeof value?.confirmed !== "boolean" ||
      typeof value.hostOnline !== "boolean"
    )
      throw Error("Invalid relay status");
    return !value.hostOnline
      ? ("offline" as const)
      : value.confirmed
        ? ("ready" as const)
        : ("pending" as const);
  } finally {
    clearTimeout(deadline);
  }
}
export function createMobileController() {
  setRandomSource((bytes) => Crypto.getRandomValues(bytes));
  return new MobileController(nativeStorage(), {
    id: Crypto.randomUUID,
    probe: probePairing,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
}
