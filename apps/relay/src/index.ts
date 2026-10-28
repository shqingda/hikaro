interface Env {
  HOSTS: DurableObjectNamespace;
  PAIRINGS: DurableObjectNamespace;
  PUBLIC_REGISTRATION?: string;
  BOOTSTRAP_TOKEN: string;
  NOTIFICATIONS: Queue<Notice>;
}
type Notice = { hostId: string; deviceId: string; id: string };
type Device = { token: string; expires?: number };
type Attachment = {
  role: "host" | "device";
  deviceId?: string;
  connectionId: string;
};
const MAX_FRAME = 1_500_000;
const idValid = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const keyValid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9+/]{43}=$/.test(v) &&
  btoa(atob(v)) === v;
const lanValid = (value: unknown): value is string[] => {
  if (!Array.isArray(value) || value.length > 4) return false;
  return value.every((item) => {
    if (typeof item !== "string") return false;
    try {
      const url = new URL(item);
      const parts = url.hostname.split(".").map(Number);
      return (
        url.protocol === "ws:" &&
        !!url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === "/" || !url.pathname) &&
        parts.length === 4 &&
        parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (parts[0] === 10 ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31))
      );
    } catch {
      return false;
    }
  });
};
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const noticeValid = (v: unknown): v is Notice =>
  record(v) &&
  idValid(v.hostId) &&
  idValid(v.deviceId) &&
  typeof v.id === "string" &&
  /^[A-Za-z0-9_.:-]{1,128}$/.test(v.id);
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const token = (r: Request) => {
  const auth = r.headers.get("Authorization");
  if (auth !== null) return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return (
    r.headers
      .get("Sec-WebSocket-Protocol")
      ?.split(",")
      .map((s) => s.trim())
      .find((s) => s.startsWith("token."))
      ?.slice(6) ?? ""
  );
};
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw Error("Invalid body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        throw Error("Body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  if (!record(value)) throw Error("Invalid body");
  return value;
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (
      !url.search &&
      /^\/pairings(?:\/\d{6}(?:\/(?:claim|request|complete|result))?)?$/.test(
        url.pathname,
      )
    )
      return env.PAIRINGS.get(env.PAIRINGS.idFromName("registry")).fetch(
        request,
      );
    const match = url.pathname.match(
      /^\/hosts\/([A-Za-z0-9_-]{43})\/(register|host-auth|enroll|activate|revoke|push|notify-enqueue|host|(?:device|device-status)\/[A-Za-z0-9_-]{43})$/,
    );
    if (!match || url.search) return json({ error: "Not found" }, 404);
    if (
      env.PUBLIC_REGISTRATION === "true" &&
      match[2] === "register" &&
      request.method === "POST"
    ) {
      const allowed = await env.PAIRINGS.get(
        env.PAIRINGS.idFromName("registry"),
      ).fetch(
        new Request("https://internal/internal/register-limit", {
          method: "POST",
          headers: {
            "CF-Connecting-IP":
              request.headers.get("CF-Connecting-IP") ?? "unknown",
          },
        }),
      );
      if (!allowed.ok) return allowed;
    }
    return env.HOSTS.get(env.HOSTS.idFromName(match[1]!)).fetch(request);
  },
  async queue(batch: MessageBatch<Notice>, env: Env) {
    for (const message of batch.messages) {
      if (!noticeValid(message.body)) {
        message.ack();
        continue;
      }
      try {
        const response = await env.HOSTS.get(
          env.HOSTS.idFromName(message.body.hostId),
        ).fetch(
          new Request("https://internal/internal/notify", {
            method: "POST",
            headers: { Authorization: "Bearer " + env.BOOTSTRAP_TOKEN },
            body: JSON.stringify(message.body),
          }),
        );
        if (
          response.ok ||
          (response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429)
        )
          message.ack();
        else message.retry();
      } catch {
        message.retry();
      }
    }
  },
};
export class HostRelay {
  private messageChain = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
  }
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const match = path.match(
      /^\/hosts\/([A-Za-z0-9_-]{43})\/([^/]+)(?:\/([A-Za-z0-9_-]{43}))?$/,
    );
    const operation = path === "/internal/notify" ? "notify" : match?.[2];
    const hostId = match?.[1];
    const secret = token(request);
    if (secret.length > 256) return json({ error: "Unauthorized" }, 401);
    const stored = await this.state.storage.get<string>("hostToken");
    const isHost =
      stored !== undefined &&
      idValid(secret) &&
      (await hash(secret)) === stored;
    if (operation === "register" && request.method === "POST") {
      if (
        this.env.PUBLIC_REGISTRATION !== "true" &&
        (!this.env.BOOTSTRAP_TOKEN ||
          (await hash(secret)) !== (await hash(this.env.BOOTSTRAP_TOKEN)))
      )
        return json({ error: "Unauthorized" }, 401);
      const value = await body(request);
      if (!idValid(value.token) || !hostId)
        return json({ error: "Invalid token" }, 400);
      const digest = await hash(value.token);
      return this.state.storage.transaction(async (tx) => {
        const existing = await tx.get<string>("hostToken");
        if (existing && existing !== digest)
          return json({ error: "Host already exists" }, 409);
        await tx.put({ hostToken: digest, hostId });
        return json({ ok: true });
      });
    }
    if (operation === "host-auth" && request.method === "GET")
      return isHost ? json({ ok: true }) : json({ error: "Unauthorized" }, 401);
    if (operation === "notify" && request.method === "POST") {
      if (
        !this.env.BOOTSTRAP_TOKEN ||
        (await hash(secret)) !== (await hash(this.env.BOOTSTRAP_TOKEN))
      )
        return json({ error: "Unauthorized" }, 401);
      const value = await body(request);
      if (
        !noticeValid(value) ||
        value.hostId !== (await this.state.storage.get("hostId"))
      )
        return json({ error: "Invalid notification" }, 400);
      return this.notify(value);
    }
    if (
      ["enroll", "activate", "revoke", "push", "notify-enqueue"].includes(
        operation ?? "",
      ) &&
      request.method === "POST"
    ) {
      if (!isHost) return json({ error: "Unauthorized" }, 401);
      const value = await body(request);
      if (operation === "enroll") {
        if (!idValid(value.id) || !idValid(value.token))
          return json({ error: "Invalid enrollment" }, 400);
        const digest = await hash(value.token);
        return this.state.storage.transaction(async (tx) => {
          const existing = await tx.get<Device>("device:" + value.id);
          if (existing)
            return json(
              { ok: existing.token === digest },
              existing.token === digest ? 200 : 409,
            );
          const devices = await tx.list<Device>({ prefix: "device:" });
          for (const [key, device] of devices)
            if (device.expires !== undefined && device.expires <= Date.now()) {
              await tx.delete(key);
              devices.delete(key);
            }
          if (devices.size >= 32)
            return json({ error: "Device limit reached" }, 409);
          await tx.put("device:" + value.id, {
            token: digest,
            expires: Date.now() + 300000,
          });
          return json({ ok: true });
        });
      }
      if (operation === "revoke" || operation === "activate") {
        if (!idValid(value.id)) return json({ error: "Invalid device" }, 400);
        const device = await this.state.storage.get<Device>(
          "device:" + value.id,
        );
        if (operation === "activate") {
          if (
            !device ||
            (device.expires !== undefined && device.expires <= Date.now())
          )
            return json({ error: "Enrollment expired" }, 410);
          await this.state.storage.put("device:" + value.id, {
            token: device.token,
          });
        } else {
          await this.state.storage.delete([
            "device:" + value.id,
            "push:" + value.id,
            "active:device:" + value.id,
          ]);
          for (const host of this.state.getWebSockets("host"))
            host.send(JSON.stringify({ type: "revoked", deviceId: value.id }));
          for (const socket of this.state.getWebSockets("device:" + value.id))
            socket.close(4003, "Revoked");
        }
        return json({ ok: true });
      }
      if (!idValid(value.deviceId))
        return json({ error: "Invalid device" }, 400);
      const device = await this.state.storage.get<Device>(
        "device:" + value.deviceId,
      );
      if (!device || device.expires !== undefined)
        return json({ error: "Device not active" }, 409);
      if (operation === "push") {
        if (value.token === null) {
          await this.state.storage.delete("push:" + value.deviceId);
          return json({ ok: true });
        }
        if (
          typeof value.token !== "string" ||
          value.token.length > 256 ||
          !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(value.token)
        )
          return json({ error: "Invalid push token" }, 400);
        await this.state.storage.put("push:" + value.deviceId, value.token);
      } else {
        const notice = { hostId, deviceId: value.deviceId, id: value.id };
        if (!noticeValid(notice))
          return json({ error: "Invalid notification" }, 400);
        await this.env.NOTIFICATIONS.send(notice);
      }
      return json({ ok: true });
    }
    if (operation === "device-status" && request.method === "GET") {
      const deviceId = match?.[3];
      const device = idValid(deviceId)
        ? await this.state.storage.get<Device>("device:" + deviceId)
        : undefined;
      if (
        !device ||
        !idValid(secret) ||
        device.token !== (await hash(secret)) ||
        (device.expires !== undefined && device.expires <= Date.now())
      )
        return json({ error: "Unauthorized" }, 401);
      return json({
        confirmed: device.expires === undefined,
        hostOnline: this.state
          .getWebSockets("host")
          .some((s) => s.readyState === WebSocket.OPEN),
      });
    }
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      !request.headers
        .get("Sec-WebSocket-Protocol")
        ?.split(",")
        .map((s) => s.trim())
        .includes("hikaro.v1")
    )
      return json({ error: "Not found" }, 404);
    if (operation !== "host" && operation !== "device")
      return json({ error: "Not found" }, 404);
    const deviceId = match?.[3];
    const role = operation;
    if (role === "host" && !isHost) return json({ error: "Unauthorized" }, 401);
    if (role === "device") {
      if (!idValid(deviceId)) return json({ error: "Invalid device" }, 400);
      const device = await this.state.storage.get<Device>("device:" + deviceId);
      if (
        !device ||
        !idValid(secret) ||
        device.token !== (await hash(secret)) ||
        (device.expires !== undefined && device.expires <= Date.now())
      )
        return json({ error: "Unauthorized" }, 401);
      if (
        !this.state
          .getWebSockets("host")
          .some((s) => s.readyState === WebSocket.OPEN)
      )
        return json({ error: "Host offline" }, 503);
    }
    const tag = role === "host" ? "host" : "device:" + deviceId;
    const connectionId = crypto.randomUUID();
    await this.state.storage.put("active:" + tag, connectionId);
    for (const old of this.state.getWebSockets(tag))
      old.close(4000, "Replaced");
    if (role === "host") {
      // A new host socket has no old cipher state. Force fresh device handshakes.
      for (const socket of this.state.getWebSockets()) {
        if ((socket.deserializeAttachment() as Attachment).role === "device")
          socket.close(1012, "Host reconnected");
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0],
      server = pair[1];
    this.state.acceptWebSocket(server, [tag]);
    server.serializeAttachment({
      role,
      deviceId,
      connectionId,
    } satisfies Attachment);
    if (role === "device")
      for (const host of this.state.getWebSockets("host")) {
        if (host.readyState === WebSocket.OPEN)
          host.send(
            JSON.stringify({ type: "connected", deviceId, connectionId }),
          );
      }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "hikaro.v1" },
    });
  }
  private async notify(notice: Notice): Promise<Response> {
    const device = await this.state.storage.get<Device>(
      "device:" + notice.deviceId,
    );
    const push = await this.state.storage.get<string>(
      "push:" + notice.deviceId,
    );
    if (!device || device.expires !== undefined || !push)
      return json({ skipped: true });
    const key = notice.deviceId + ":" + notice.id;
    const reservation = await this.state.storage.transaction(async (tx) => {
      const now = Date.now();
      const entries = (
        (await tx.get<{ key: string; at: number; sent: boolean }[]>(
          "noticeLog",
        )) ?? []
      ).filter((e) => now - e.at < 86400000);
      const previous = entries.find((e) => e.key === key);
      if (previous && (previous.sent || now - previous.at < 60000))
        return previous.sent ? "duplicate" : "busy";
      const next = entries.filter((e) => e.key !== key).slice(-999);
      next.push({ key, at: now, sent: false });
      await tx.put("noticeLog", next);
      return "send";
    });
    if (reservation === "duplicate") return json({ duplicate: true });
    if (reservation === "busy") return json({ error: "Delivery pending" }, 503);
    let ok = false;
    let invalidToken = false;
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: push,
          title: "Hikaro",
          body: "A task needs your attention.",
          data: { hostId: notice.hostId },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const payload: unknown = await response.json();
      const ticket =
        record(payload) && record(payload.data) ? payload.data : undefined;
      ok = response.ok && ticket?.status === "ok";
      invalidToken =
        ticket?.status === "error" &&
        record(ticket.details) &&
        ticket.details.error === "DeviceNotRegistered";
    } catch {
      /* Queues retries delivery; user content never enters this request. */
    }
    if (invalidToken)
      await this.state.storage.delete("push:" + notice.deviceId);
    await this.state.storage.transaction(async (tx) => {
      const entries =
        (await tx.get<{ key: string; at: number; sent: boolean }[]>(
          "noticeLog",
        )) ?? [];
      await tx.put(
        "noticeLog",
        ok || invalidToken
          ? entries.map((e) => (e.key === key ? { ...e, sent: true } : e))
          : entries.filter((e) => e.key !== key),
      );
    });
    return ok || invalidToken
      ? json({ ok: true })
      : json({ error: "Push failed" }, 502);
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const task = this.messageChain.then(() => this.forward(socket, message));
    this.messageChain = task.catch(() => {});
    return task;
  }
  private async forward(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > MAX_FRAME + 256) {
      socket.close(1009, "Frame too large");
      return;
    }
    const a = socket.deserializeAttachment() as Attachment;
    const tag = a.role === "host" ? "host" : "device:" + a.deviceId;
    if ((await this.state.storage.get("active:" + tag)) !== a.connectionId) {
      socket.close(4000, "Replaced");
      return;
    }
    try {
      if (a.role === "host") {
        const m: unknown = JSON.parse(message);
        if (
          !record(m) ||
          !idValid(m.to) ||
          typeof m.connectionId !== "string" ||
          typeof m.body !== "string" ||
          m.body.length > MAX_FRAME
        )
          throw Error("Invalid frame");
        if (
          (await this.state.storage.get("active:device:" + m.to)) !==
          m.connectionId
        )
          return;
        for (const peer of this.state.getWebSockets("device:" + m.to))
          if (
            peer.readyState === WebSocket.OPEN &&
            (peer.deserializeAttachment() as Attachment).connectionId ===
              m.connectionId
          )
            peer.send(m.body);
      } else {
        const device = await this.state.storage.get<Device>(
          "device:" + a.deviceId,
        );
        if (
          !device ||
          (device.expires !== undefined && device.expires <= Date.now())
        ) {
          socket.close(4003, "Revoked or expired");
          return;
        }
        for (const host of this.state.getWebSockets("host"))
          if (host.readyState === WebSocket.OPEN)
            host.send(
              JSON.stringify({
                deviceId: a.deviceId,
                connectionId: a.connectionId,
                body: message,
              }),
            );
      }
    } catch {
      socket.close(1003, "Invalid frame");
    }
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const a = socket.deserializeAttachment() as Attachment;
    const tag = a.role === "host" ? "host" : "device:" + a.deviceId;
    if ((await this.state.storage.get("active:" + tag)) === a.connectionId) {
      await this.state.storage.delete("active:" + tag);
      if (a.role === "host")
        for (const peer of this.state.getWebSockets()) {
          if ((peer.deserializeAttachment() as Attachment).role === "device")
            peer.close(1012, "Host disconnected");
        }
      else
        for (const host of this.state.getWebSockets("host")) {
          if (host.readyState === WebSocket.OPEN)
            host.send(
              JSON.stringify({
                type: "disconnected",
                deviceId: a.deviceId,
                connectionId: a.connectionId,
              }),
            );
        }
    }
    socket.close(
      code === 1005 || code === 1006 ? 1000 : code,
      reason.slice(0, 100),
    );
  }
}

type Claim = { deviceId: string; publicKey: string; token: string };
type Enrollment = {
  hostId: string;
  hostKey: string;
  expires: number;
  lan?: string[];
  claim?: Claim;
  approved?: boolean;
};
/** Short codes discover public keys; encryption identities stay on each device. */
export class PairingRegistry {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  private async authorized(request: Request, hostId: string) {
    return (
      await this.env.HOSTS.get(this.env.HOSTS.idFromName(hostId)).fetch(
        new Request(`https://internal/hosts/${hostId}/host-auth`, {
          headers: { Authorization: `Bearer ${token(request)}` },
        }),
      )
    ).ok;
  }
  private async limit(request: Request, category = "pair", maximum = 30) {
    const key =
      "rate:" +
      category +
      ":" +
      (await hash(request.headers.get("CF-Connecting-IP") ?? "unknown"));
    const allowed = await this.state.storage.transaction(async (tx) => {
      const now = Date.now();
      let bucket = await tx.get<{ count: number; expires: number }>(key);
      if (!bucket || bucket.expires <= now)
        bucket = { count: 0, expires: now + 60000 };
      if (bucket.count >= maximum) return false;
      bucket.count++;
      await tx.put(key, bucket);
      return true;
    });
    await this.scheduleCleanup();
    return allowed;
  }
  private async scheduleCleanup() {
    if ((await this.state.storage.getAlarm()) === null)
      await this.state.storage.setAlarm(Date.now() + 60000);
  }
  async alarm() {
    const now = Date.now();
    const entries = await this.state.storage.list<{ expires: number }>();
    for (const [key, value] of entries)
      if (value.expires <= now) await this.state.storage.delete(key);
    if ((await this.state.storage.list({ limit: 1 })).size)
      await this.state.storage.setAlarm(now + 60000);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
  }
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/internal/register-limit" && request.method === "POST")
      return (await this.limit(request, "register", 10))
        ? json({ ok: true })
        : json({ error: "Too many registrations; retry in a minute" }, 429);
    if (path === "/pairings" && request.method === "POST") {
      const value = await body(request);
      if (
        !idValid(value.hostId) ||
        !keyValid(value.hostKey) ||
        (value.lan !== undefined && !lanValid(value.lan)) ||
        typeof value.expires !== "number" ||
        !Number.isSafeInteger(value.expires) ||
        value.expires <= Date.now() ||
        value.expires > Date.now() + 300000
      )
        return json({ error: "Invalid enrollment" }, 400);
      if (!(await this.authorized(request, value.hostId)))
        return json({ error: "Unauthorized" }, 401);
      const entry: Enrollment = {
        hostId: value.hostId,
        hostKey: value.hostKey,
        expires: value.expires,
        ...(value.lan === undefined ? {} : { lan: value.lan as string[] }),
      };
      const response = await this.state.storage.transaction(async (tx) => {
        const old = await tx.get<{ code: string }>("host:" + entry.hostId);
        // Re-running /pair replaces the previous invitation from this host.
        if (old) await tx.delete("code:" + old.code);
        for (let attempt = 0; attempt < 10; attempt++) {
          const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
          if (random >= 4294000000) continue;
          const code = String(random % 1000000).padStart(6, "0");
          if (old?.code === code || (await tx.get("code:" + code))) continue;
          await tx.put("code:" + code, entry);
          await tx.put("host:" + entry.hostId, {
            code,
            expires: entry.expires,
          });
          return json({ code, expires: entry.expires });
        }
        return json({ error: "Pairing capacity reached" }, 503);
      });
      await this.scheduleCleanup();
      return response;
    }
    const match = path.match(
      /^\/pairings\/(\d{6})(?:\/(claim|request|complete|result))?$/,
    );
    if (!match) return json({ error: "Not found" }, 404);
    const operation = match[2],
      key = "code:" + match[1];
    if (
      (!operation && request.method === "GET") ||
      (operation === "claim" && request.method === "POST")
    )
      if (!(await this.limit(request)))
        return json({ error: "Too many attempts; retry in a minute" }, 429);
    const entry = await this.state.storage.get<Enrollment>(key);
    if (!entry || entry.expires <= Date.now())
      return json({ error: "Pairing code expired" }, 410);
    if (!operation && request.method === "GET")
      return json({
        hostId: entry.hostId,
        hostKey: entry.hostKey,
        expires: entry.expires,
        ...(entry.lan === undefined ? {} : { lan: entry.lan }),
      });
    if (operation === "claim" && request.method === "POST") {
      const value = await body(request);
      if (
        !idValid(value.deviceId) ||
        !keyValid(value.publicKey) ||
        !idValid(value.token)
      )
        return json({ error: "Invalid claim" }, 400);
      const claim: Claim = {
        deviceId: value.deviceId,
        publicKey: value.publicKey,
        token: value.token,
      };
      return this.state.storage.transaction(async (tx) => {
        const current = await tx.get<Enrollment>(key);
        if (!current || current.expires <= Date.now())
          return json({ error: "Pairing code expired" }, 410);
        if (current.claim) {
          const same = Object.entries(claim).every(
            ([name, v]) => current.claim![name as keyof Claim] === v,
          );
          return same
            ? json({ ok: true })
            : json({ error: "Pairing code already claimed" }, 409);
        }
        await tx.put(key, { ...current, claim });
        return json({ ok: true });
      });
    }
    if (operation === "result" && request.method === "GET") {
      if (!entry.claim || token(request) !== entry.claim.token)
        return json({ error: "Unauthorized" }, 401);
      return json({ approved: entry.approved ?? null });
    }
    if (
      (operation === "request" && request.method === "GET") ||
      (operation === "complete" && request.method === "POST")
    ) {
      if (!(await this.authorized(request, entry.hostId)))
        return json({ error: "Unauthorized" }, 401);
      if (operation === "request") return json(entry.claim ?? null);
      const value = await body(request);
      if (!idValid(value.deviceId) || typeof value.approved !== "boolean")
        return json({ error: "Invalid confirmation" }, 400);
      return this.state.storage.transaction(async (tx) => {
        const current = await tx.get<Enrollment>(key);
        if (!current || current.expires <= Date.now())
          return json({ error: "Pairing code expired" }, 410);
        if (
          !current.claim ||
          current.claim.deviceId !== value.deviceId ||
          (current.approved !== undefined &&
            current.approved !== value.approved)
        )
          return json({ error: "Pairing request changed" }, 409);
        await tx.put(key, { ...current, approved: value.approved });
        return json({ ok: true });
      });
    }
    return json({ error: "Not found" }, 404);
  }
}
