import {
  SecureChannel,
  randomToken,
  validateIdentity,
  publicKeyBytes,
  isRecord,
  isToken,
  MAX_FRAME_BYTES,
  type Identity,
} from "../../crypto/src/index.ts";
export type Pairing = {
  v: 1;
  relay: string;
  hostId: string;
  deviceId: string;
  token: string;
  identity: Identity;
  hostKey: string;
  expires: number;
};
export function validateRelay(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw Error("Invalid relay URL");
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw Error(
      "Relay must be a wss:// origin without credentials, path or query",
    );
  return url.origin;
}
export function validatePairing(
  value: unknown,
  unexpired = false,
): asserts value is Pairing {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !isToken(value.hostId) ||
    !isToken(value.deviceId) ||
    !isToken(value.token) ||
    typeof value.expires !== "number" ||
    !Number.isSafeInteger(value.expires) ||
    value.expires <= 0 ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "relay",
          "hostId",
          "deviceId",
          "token",
          "identity",
          "hostKey",
          "expires",
        ].includes(key),
    )
  )
    throw Error("Invalid pairing data");
  validateRelay(value.relay);
  publicKeyBytes(value.hostKey);
  validateIdentity(value.identity);
  if (value.hostKey === value.identity.publicKey)
    throw Error("Invalid pairing identity");
  if (
    unexpired &&
    (value.expires <= Date.now() || value.expires > Date.now() + 600_000)
  )
    throw Error("Pairing code expired or has an invalid expiry");
}
export function parsePairing(uri: string): Pairing {
  const prefix = "hikaro://pair#";
  if (typeof uri !== "string" || !uri.startsWith(prefix) || uri.length > 8192)
    throw Error("Invalid Hikaro pairing code");
  const p: unknown = JSON.parse(decodeURIComponent(uri.slice(prefix.length)));
  validatePairing(p, true);
  return p;
}
export type RemoteSocket = Pick<
  WebSocket,
  | "readyState"
  | "bufferedAmount"
  | "send"
  | "close"
  | "onopen"
  | "onmessage"
  | "onerror"
  | "onclose"
>;
export type RemoteClientOptions = {
  socket?: (url: string, protocols: string[]) => RemoteSocket;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
  reconnectMs?: number;
};
export class RemoteClient {
  private socket?: RemoteSocket;
  private channel?: SecureChannel;
  private listeners = new Set<(m: any) => void>();
  private observers = new Set<(frame: unknown) => void>();
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stopped = true;
  private ready = false;
  private attempt = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    readonly pairing: Pairing,
    private options: RemoteClientOptions = {},
  ) {
    // The QR expiry limits enrollment, not the lifetime of an already paired device.
    validatePairing(pairing);
  }
  subscribe(fn: (m: any) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  /** All decrypted protocol frames, before request routing, in wire order. */
  observe(fn: (frame: unknown) => void) {
    this.observers.add(fn);
    return () => {
      this.observers.delete(fn);
    };
  }
  private emit(m: any) {
    for (const f of this.listeners) {
      try {
        f(m);
      } catch {
        console.error("Remote connection listener failed");
      }
    }
  }
  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error(message));
    }
    this.pending.clear();
  }
  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.dial();
  }
  private dial() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const p = this.pairing;
    const channel = new SecureChannel("device", p.identity, p.hostKey);
    this.channel = channel;
    this.ready = false;
    this.emit({ type: "connection", status: "connecting" });
    let socket: RemoteSocket;
    try {
      socket = (
        this.options.socket ??
        ((url, protocols) => new WebSocket(url, protocols))
      )(
        validateRelay(p.relay) + "/hosts/" + p.hostId + "/device/" + p.deviceId,
        ["hikaro.v1", "token." + p.token],
      );
    } catch {
      this.emit({ type: "error", error: "Could not open remote connection." });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const current = () => generation === this.generation && !this.stopped;
    const fail = (code: number, reason: string) => {
      if (!current()) return;
      this.ready = false;
      socket.close(code, reason);
    };
    this.deadline = setTimeout(() => fail(4001, "Connection timed out"), 15000);
    let lastPong = Date.now();
    socket.onopen = () => {
      if (!current()) return;
      clearTimeout(this.deadline);
      this.deadline = setTimeout(
        () => fail(4001, "Host confirmation timed out"),
        this.options.handshakeTimeoutMs ?? 120000,
      );
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      try {
        if (event.data === "pong") {
          lastPong = Date.now();
          return;
        }
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_FRAME_BYTES
        )
          throw Error("Invalid encrypted frame");
        const result = channel.receive(event.data);
        if (result.reply) socket.send(result.reply);
        if (result.ready) {
          this.ready = true;
          this.attempt = 0;
          clearTimeout(this.deadline);
          lastPong = Date.now();
          const interval = this.options.heartbeatMs ?? 25000;
          this.heartbeat = setInterval(() => {
            if (!current()) return;
            if (Date.now() - lastPong > interval * 3) {
              fail(4001, "Relay heartbeat timed out");
              return;
            }
            if (socket.readyState === 1) socket.send("ping");
          }, interval);
          this.emit({ type: "connection", status: "connected" });
        }
        if (Object.hasOwn(result, "data")) {
          const m = result.data;
          if (!isRecord(m) || typeof m.type !== "string")
            throw Error("Invalid remote message");
          for (const observer of this.observers) {
            try {
              observer(m);
            } catch {
              /* A view must not break the authenticated channel. */
            }
          }
          if (m.type === "response") {
            if (
              typeof m.id !== "string" ||
              (m.error !== undefined && typeof m.error !== "string")
            )
              throw Error("Invalid remote response");
            const request = this.pending.get(m.id);
            if (request) {
              clearTimeout(request.timer);
              this.pending.delete(m.id);
              if (m.error !== undefined) request.reject(Error(m.error));
              else request.resolve(m.result);
            }
          } else this.emit(m);
        }
      } catch {
        this.emit({
          type: "error",
          error: "Encrypted channel authentication failed.",
        });
        fail(4002, "Authentication failed");
      }
    };
    socket.onerror = () => {
      if (current())
        this.emit({
          type: "error",
          error: "Connection failed. Check the relay and paired host.",
        });
    };
    socket.onclose = (event) => {
      if (!current()) return;
      this.ready = false;
      this.socket = undefined;
      this.channel = undefined;
      clearTimeout(this.deadline);
      clearInterval(this.heartbeat);
      this.rejectPending("Connection lost; command outcome may be unknown.");
      this.emit({ type: "connection", status: "disconnected" });
      // Revocation, identity errors and replacement require explicit user action.
      if ([4000, 4002, 4003, 4401, 4403].includes(event.code)) {
        this.stopped = true;
        this.emit({
          type: "connection",
          status: "blocked",
          reason:
            event.code === 4000
              ? "replaced"
              : event.code === 4002
                ? "authentication"
                : "revoked",
        });
      } else this.scheduleReconnect();
    };
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    this.timer = setTimeout(
      () => this.dial(),
      this.options.reconnectMs ??
        Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) +
          Math.random() * 500,
    );
  }
  /** Send an already prepared command exactly once. Scope is authenticated by the host. */
  send(frame: {
    id: string;
    scope: string;
    method: string;
    params: Record<string, unknown>;
  }) {
    const { socket, channel } = this;
    if (!this.ready || socket?.readyState !== 1 || !channel)
      throw Error("Not connected");
    if (socket.bufferedAmount > 2_000_000)
      throw Error("Remote transport is congested");
    if (
      frame.scope !== this.pairing.deviceId ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(frame.id) ||
      frame.method.length > 64 ||
      !isRecord(frame.params)
    )
      throw Error("Invalid remote command or scope");
    socket.send(channel.send(frame));
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    requestId?: string,
  ) {
    const socket = this.socket,
      channel = this.channel;
    if (socket?.readyState !== 1 || !channel || !this.ready)
      return Promise.reject(Error("Not connected"));
    if (this.pending.size >= 32 || socket.bufferedAmount > 2_000_000)
      return Promise.reject(Error("Remote transport is congested"));
    if (typeof method !== "string" || method.length > 64 || !isRecord(params))
      return Promise.reject(Error("Invalid command"));
    const id = requestId ?? randomToken();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || this.pending.has(id))
      return Promise.reject(Error("Invalid or pending request ID"));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Request timed out; command outcome may be unknown."));
      }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(channel.send({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    this.stopped = true;
    this.ready = false;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    this.rejectPending("Connection closed; command outcome may be unknown.");
    const socket = this.socket;
    this.socket = undefined;
    this.channel = undefined;
    socket?.close(1000, "Client closed");
    this.emit({ type: "connection", status: "disconnected" });
  }
}
