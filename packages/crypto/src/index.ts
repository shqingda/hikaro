import nacl from "tweetnacl";

export const MAX_PLAINTEXT_BYTES = 1_000_000;
export const MAX_FRAME_BYTES = 1_500_000;
const DOMAIN = "hikaro.remote.v1";
export const encode = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096)
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(text);
};
export const decode = (text: string): Uint8Array => {
  if (
    typeof text !== "string" ||
    text.length > MAX_FRAME_BYTES ||
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    )
  )
    throw Error("Invalid base64 payload");
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (encode(bytes) !== text) throw Error("Noncanonical base64 payload");
  return bytes;
};
export type Identity = { publicKey: string; secretKey: string };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function publicKeyBytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw Error("Invalid public key");
  const key = decode(value);
  if (key.length !== nacl.box.publicKeyLength)
    throw Error("Invalid public key");
  // X25519 low-order points cannot authenticate possession of a private key.
  if (
    nacl.scalarMult(new Uint8Array(32).fill(9), key).every((byte) => byte === 0)
  )
    throw Error("Invalid public key");
  return key;
}
export function validateIdentity(value: unknown): asserts value is Identity {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => k !== "publicKey" && k !== "secretKey") ||
    typeof value.secretKey !== "string"
  )
    throw Error("Invalid identity");
  publicKeyBytes(value.publicKey);
  const secret = decode(value.secretKey);
  if (
    secret.length !== nacl.box.secretKeyLength ||
    encode(nacl.box.keyPair.fromSecretKey(secret).publicKey) !== value.publicKey
  )
    throw Error("Identity key mismatch");
}
export function createIdentity(): Identity {
  const pair = nacl.box.keyPair();
  return {
    publicKey: encode(pair.publicKey),
    secretKey: encode(pair.secretKey),
  };
}
export const randomToken = () =>
  encode(nacl.randomBytes(32))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export function setRandomSource(fill: (bytes: Uint8Array) => void) {
  nacl.setPRNG((bytes, n) => fill(bytes.subarray(0, n)));
}
export function seal(value: unknown, peerKey: string, secretKey: string) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw Error("Invalid encrypted payload");
  const plain = new TextEncoder().encode(serialized);
  if (plain.length > MAX_PLAINTEXT_BYTES)
    throw Error("Encrypted frame too large");
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return JSON.stringify({
    nonce: encode(nonce),
    cipher: encode(
      nacl.box(plain, nonce, publicKeyBytes(peerKey), decode(secretKey)),
    ),
  });
}
export function open(
  frame: string,
  peerKey: string,
  secretKey: string,
): unknown {
  if (typeof frame !== "string" || frame.length > MAX_FRAME_BYTES)
    throw Error("Encrypted frame too large");
  const envelope: unknown = JSON.parse(frame);
  if (
    !isRecord(envelope) ||
    Object.keys(envelope).length !== 2 ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.cipher !== "string"
  )
    throw Error("Invalid encrypted envelope");
  const nonce = decode(envelope.nonce),
    cipher = decode(envelope.cipher);
  if (
    nonce.length !== nacl.box.nonceLength ||
    cipher.length < nacl.box.overheadLength ||
    cipher.length > MAX_PLAINTEXT_BYTES + nacl.box.overheadLength
  )
    throw Error("Invalid encrypted envelope");
  const plain = nacl.box.open(
    cipher,
    nonce,
    publicKeyBytes(peerKey),
    decode(secretKey),
  );
  if (!plain) throw Error("Message authentication failed");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

/** NaCl box supplies authenticated encryption. Fresh challenges bind roles and
 * connections. This application protocol does not provide forward secrecy.
 * The transport must close the connection after any receive error. */
export class SecureChannel {
  private readonly challenge = randomToken();
  private peerChallenge?: string;
  private sendSeq = 0;
  private recvSeq = 0;
  private ready = false;
  private started = false;
  constructor(
    private role: "host" | "device",
    private identity: Identity,
    private peerKey: string,
  ) {
    validateIdentity(identity);
    publicKeyBytes(peerKey);
    if (identity.publicKey === peerKey)
      throw Error("Peer must have a distinct identity");
  }
  private encrypt(value: Record<string, unknown>) {
    return seal(
      { domain: DOMAIN, v: 1, ...value },
      this.peerKey,
      this.identity.secretKey,
    );
  }
  hello() {
    if (this.role !== "host" || this.started)
      throw Error("Handshake already started");
    this.started = true;
    return this.encrypt({ type: "hello", challenge: this.challenge });
  }
  receive(frame: string): { reply?: string; data?: unknown; ready?: boolean } {
    const m = open(frame, this.peerKey, this.identity.secretKey);
    if (!isRecord(m) || m.v !== 1 || m.domain !== DOMAIN)
      throw Error("Unsupported encrypted protocol");
    if (m.type === "hello" && this.role === "device" && !this.started) {
      if (!isToken(m.challenge)) throw Error("Invalid challenge");
      this.started = true;
      this.peerChallenge = m.challenge;
      return {
        reply: this.encrypt({
          type: "proof",
          host: m.challenge,
          device: this.challenge,
        }),
      };
    }
    if (
      m.type === "proof" &&
      this.role === "host" &&
      this.started &&
      !this.ready
    ) {
      if (m.host !== this.challenge || !isToken(m.device))
        throw Error("Handshake mismatch");
      const reply = this.encrypt({
        type: "ready",
        host: this.challenge,
        device: m.device,
      });
      this.peerChallenge = m.device;
      this.ready = true;
      return { reply, ready: true };
    }
    if (
      m.type === "ready" &&
      this.role === "device" &&
      this.started &&
      !this.ready
    ) {
      if (m.host !== this.peerChallenge || m.device !== this.challenge)
        throw Error("Handshake mismatch");
      this.ready = true;
      return { ready: true };
    }
    const host = this.role === "host" ? this.challenge : this.peerChallenge;
    const device = this.role === "device" ? this.challenge : this.peerChallenge;
    if (
      !this.ready ||
      m.type !== "data" ||
      m.host !== host ||
      m.device !== device ||
      m.from !== (this.role === "host" ? "device" : "host") ||
      !Number.isSafeInteger(m.seq) ||
      m.seq !== this.recvSeq + 1 ||
      !Object.hasOwn(m, "data")
    )
      throw Error("Out-of-order, reflected, or stale message");
    this.recvSeq = m.seq as number;
    return { data: m.data };
  }
  send(data: unknown) {
    if (!this.ready) throw Error("Handshake incomplete");
    if (this.sendSeq >= Number.MAX_SAFE_INTEGER)
      throw Error("Channel sequence exhausted");
    const frame = this.encrypt({
      type: "data",
      from: this.role,
      host: this.role === "host" ? this.challenge : this.peerChallenge,
      device: this.role === "device" ? this.challenge : this.peerChallenge,
      seq: this.sendSeq + 1,
      data,
    });
    this.sendSeq++;
    return frame;
  }
}
