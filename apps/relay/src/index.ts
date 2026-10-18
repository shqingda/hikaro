interface Env {
  HOSTS: DurableObjectNamespace;
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
const json = (data: unknown, status = 200) => Response.json(data, { status });
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
    const match = url.pathname.match(
      /^\/hosts\/([A-Za-z0-9_-]{43})\/(register|enroll|activate|revoke|push|notify-enqueue|host|(?:device|device-status)\/[A-Za-z0-9_-]{43})$/,
    );
    if (!match || url.search) return json({ error: "Not found" }, 404);
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
        !this.env.BOOTSTRAP_TOKEN ||
        (await hash(secret)) !== (await hash(this.env.BOOTSTRAP_TOKEN))
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
