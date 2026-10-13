import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { setRandomSource } from "../../../packages/crypto/src/index.ts";
import {
  RemoteClient,
  parsePairing,
  type Pairing,
} from "../../../packages/remote/src/client.ts";
setRandomSource((bytes) => Crypto.getRandomValues(bytes));
const key = "hikaro.pairing";
let client: RemoteClient | undefined;
let opening: Promise<RemoteClient | undefined> | undefined;
let generation = 0;
export async function pair(uri: string) {
  const pairing = parsePairing(uri.trim());
  await SecureStore.setItemAsync(key, JSON.stringify(pairing));
  generation++;
  opening = undefined;
  client?.close();
  client = undefined;
  await SecureStore.deleteItemAsync("hikaro.session");
}
export async function connection() {
  if (client) return client;
  if (opening) return opening;
  const current = generation;
  const pending = (async () => {
    const value = await SecureStore.getItemAsync(key);
    if (!value || current !== generation) return undefined;
    let pairing: Pairing;
    try {
      pairing = JSON.parse(value) as Pairing;
      if (
        pairing.v !== 1 ||
        !pairing.hostId ||
        !pairing.deviceId ||
        !pairing.identity?.secretKey ||
        !pairing.hostKey ||
        !pairing.token ||
        !pairing.relay?.startsWith("wss://")
      )
        throw Error();
    } catch {
      throw Error("Saved pairing could not be read. Pair your computer again.");
    }
    client = new RemoteClient(pairing);
    return client;
  })();
  opening = pending;
  try {
    return await pending;
  } finally {
    if (opening === pending) opening = undefined;
  }
}
export async function forget() {
  generation++;
  opening = undefined;
  client?.close();
  client = undefined;
  await SecureStore.deleteItemAsync(key);
  await SecureStore.deleteItemAsync("hikaro.session");
}
