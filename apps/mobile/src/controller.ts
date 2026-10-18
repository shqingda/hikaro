import * as z from "zod";
import {
  RemoteClient,
  parsePairing,
  validatePairing,
  validateRelay,
  type Pairing,
  type RemoteClientOptions,
} from "../../../packages/remote/src/client.ts";
import {
  ClientConnection,
  type ConnectionOptions,
  type IntentStore,
} from "../../../packages/client-core/src/connection.ts";

const sessionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(100000),
  cwd: z.string().max(100000),
  createdAt: z.number(),
});
const itemSchema = z.object({
  seq: z.number().int().nonnegative(),
  message: z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    text: z.string().max(20000),
    timestamp: z.number(),
    textLength: z.number().int().nonnegative().optional(),
    imageCount: z.number().int().nonnegative().optional(),
  }),
});
const pageSchema = z.object({
  items: z.array(itemSchema).max(20),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});
export type MobileMessage = z.infer<typeof itemSchema>;
export type MobileSession = z.infer<typeof sessionSchema>;
export interface MobileStorage {
  read(): Promise<string | null>;
  write(credential: string): Promise<void>;
  erase(): Promise<void>;
  journal(scope: string): IntentStore;
  clear(scope: string): Promise<void>;
}
export type MobileOptions = Omit<ConnectionOptions, "intents"> & {
  probe(pairing: Pairing): Promise<"ready" | "pending" | "offline" | "revoked">;
  socketOptions?: RemoteClientOptions;
};
export const pairingScope = (p: Pairing) =>
  JSON.stringify([validateRelay(p.relay), p.hostId, p.hostKey, p.deviceId]);
const allowed = new Set([
  "hello",
  "session.current",
  "session.list",
  "messages.read",
  "session.resume",
  "command.receipt",
]);
export type MobileState = {
  phase:
    | "unpaired"
    | "review"
    | "restoring"
    | "connecting"
    | "connected"
    | "offline"
    | "background"
    | "revoked"
    | "blocked"
    | "error";
  review: {
    relay: string;
    hostId: string;
    deviceId: string;
    hostKey: string;
  } | null;
  deviceId: string | null;
  relay: string | null;
  session: MobileSession | null;
  sessions: MobileSession[];
  offset: number;
  moreSessions: boolean;
  messages: MobileMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  busy: boolean;
  stream: string;
  streamTruncated: boolean;
  runId: string | null;
  runStatus: string;
  loading: boolean;
  error: string | null;
  unknown: number;
};
const empty = (phase: MobileState["phase"]): MobileState => ({
  phase,
  review: null,
  deviceId: null,
  relay: null,
  session: null,
  sessions: [],
  offset: 0,
  moreSessions: false,
  messages: [],
  hasOlder: false,
  hasNewer: false,
  busy: false,
  stream: "",
  streamTruncated: false,
  runId: null,
  runStatus: "idle",
  loading: false,
  error: null,
  unknown: 0,
});
/** A read-only view. No public escape hatch exposes mutation-capable transport. */
export class MobileController {
  private value = empty("unpaired");
  private listeners = new Set<() => void>();
  private epoch = 0;
  private historyEpoch = 0;
  private listEpoch = 0;
  private credentialQueue: Promise<unknown> = Promise.resolve();
  private pendingPairing?: Pairing;
  private pairing?: Pairing;
  private client?: ClientConnection;
  private transport?: RemoteClient;
  private releases: Array<() => void> = [];
  private disposed = false;
  private refresh?: Promise<void>;
  private refreshAgain = false;
  private paint?: () => void;
  constructor(
    private storage: MobileStorage,
    private options: MobileOptions,
  ) {}
  get state(): MobileState {
    return this.value;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<MobileState>, immediate = true) {
    this.value = { ...this.value, ...patch };
    const notify = () => {
      this.paint = undefined;
      for (const fn of this.listeners) fn();
    };
    if (immediate) {
      this.paint?.();
      this.paint = undefined;
      notify();
    } else if (!this.paint) this.paint = this.options.schedule(notify, 16);
  }
  private credentials<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.credentialQueue.then(operation, operation);
    this.credentialQueue = task;
    return task;
  }
  private stop() {
    this.paint?.();
    this.paint = undefined;
    for (const release of this.releases.splice(0)) release();
    this.client?.close();
    this.client = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.historyEpoch++;
    this.listEpoch++;
    this.refresh = undefined;
    this.refreshAgain = false;
  }
  review(uri: string): void {
    if (this.disposed) throw Error("Client is closed");
    if (this.pairing) throw Error("Remove the current pairing first");
    const p = parsePairing(uri);
    const serialized = JSON.stringify({ ...p, relay: validateRelay(p.relay) });
    if (new TextEncoder().encode(serialized).length > 2048)
      throw Error("Pairing data exceeds secure storage capacity");
    this.epoch++;
    this.stop();
    this.pendingPairing = JSON.parse(serialized);
    this.update({
      ...empty("review"),
      review: {
        relay: validateRelay(p.relay),
        hostId: p.hostId,
        deviceId: p.deviceId,
        hostKey: p.hostKey,
      },
    });
  }
  async confirm(): Promise<void> {
    const p = this.pendingPairing;
    if (!p || this.disposed) throw Error("Review a pairing code first");
    validatePairing(p, true);
    const epoch = ++this.epoch;
    this.stop();
    this.update({ phase: "restoring", error: null });
    try {
      await this.credentials(() => this.storage.write(JSON.stringify(p)));
      if (epoch !== this.epoch || this.disposed) return;
      this.pendingPairing = undefined;
      await this.connect(p, epoch);
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          phase: "error",
          error: "无法保存或连接这台电脑，请重试。",
        });
      throw error;
    }
  }
  async restore(): Promise<void> {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.stop();
    this.pendingPairing = undefined;
    this.update({ ...empty("restoring") });
    try {
      const raw = await this.credentials(() => this.storage.read());
      if (epoch !== this.epoch || this.disposed) return;
      if (raw === null) {
        this.update(empty("unpaired"));
        return;
      }
      if (new TextEncoder().encode(raw).length > 2048)
        throw Error("Invalid stored credential");
      const p: unknown = JSON.parse(raw);
      validatePairing(p); // Enrollment expiry does not expire an already paired identity.
      await this.connect(p, epoch);
    } catch {
      if (epoch === this.epoch)
        this.update({
          ...empty("error"),
          error: "无法读取或验证连接。请重试，或移除后重新配对。",
        });
    }
  }
  private async connect(p: Pairing, epoch: number) {
    this.pairing = p;
    this.update({
      phase: "connecting",
      review: null,
      deviceId: p.deviceId,
      relay: validateRelay(p.relay),
      error: null,
    });
    const probe = await this.options.probe(p);
    if (epoch !== this.epoch || this.disposed) return;
    if (probe === "revoked") {
      await this.revoked(epoch);
      return;
    }
    const transport = new RemoteClient(p, this.options.socketOptions);
    const journal = this.storage.journal(pairingScope(p));
    const client = new ClientConnection(
      p.deviceId,
      {
        observe: (fn) => transport.observe(fn),
        send: (frame) => {
          if (!allowed.has(frame.method))
            throw Error("M0 allows read-only operations");
          return transport.send(frame);
        },
      },
      {
        ...this.options,
        intents: {
          load: () => this.credentials(() => journal.load()),
          save: (intents) =>
            this.credentials(async () => {
              // Serialize native journal commits with forget/revoke. A closed view
              // must not resurrect metadata after its credential has been erased.
              if (epoch === this.epoch && this.transport === transport)
                await journal.save(intents);
            }),
        },
      },
    );
    this.transport = transport;
    this.client = client;
    let ready = false,
      selected: string | undefined;
    this.releases.push(
      client.subscribe(() => {
        if (epoch !== this.epoch) return;
        const s = client.state;
        if (client.error) {
          this.epoch++;
          this.stop();
          this.update({
            ...empty("blocked"),
            error: "无法验证主机状态。请重新连接。",
            deviceId: p.deviceId,
            relay: validateRelay(p.relay),
          });
          return;
        }
        const current = s.session?.id;
        const restored = s.canAct && (!ready || selected !== current);
        if (selected !== current) {
          this.historyEpoch++;
          this.update({ messages: [], hasOlder: false, hasNewer: false });
        }
        selected = current;
        ready = s.canAct;
        this.update(
          {
            phase: s.canAct
              ? "connected"
              : s.connection === "offline"
                ? "offline"
                : "connecting",
            session: s.session,
            stream: s.stream,
            busy: s.busy,
            streamTruncated: s.streamTruncated,
            runId: s.runId,
            runStatus: s.runStatus,
            error: null,
            unknown: client.receipts.filter((r) => r.status === "unknown")
              .length,
          },
          false,
        );
        if (restored) void this.reload(epoch);
      }),
    );
    this.releases.push(
      transport.subscribe((frame) => {
        if (epoch !== this.epoch) return;
        if (frame.type === "connection") {
          if (frame.status === "connected")
            void client.connected().catch(() => {
              if (epoch === this.epoch && this.client === client)
                this.update({
                  phase: "offline",
                  error: "连接尚未恢复，请确认电脑在线并允许这台手机。",
                });
            });
          else if (frame.status === "blocked") {
            if (frame.reason === "replaced") {
              this.epoch++;
              this.stop();
              this.update({
                ...empty("blocked"),
                deviceId: p.deviceId,
                relay: validateRelay(p.relay),
                error: "此设备已在其他位置连接。请确认后重连。",
              });
            } else void this.revoked(epoch);
          } else {
            client.disconnected();
            this.update({
              phase: frame.status === "connecting" ? "connecting" : "offline",
            });
          }
        } else if (frame.type === "error")
          this.update({ error: "暂时无法连接，请检查网络、电脑及配对状态。" });
      }),
    );
    this.releases.push(
      transport.observe((raw: any) => {
        if (
          epoch === this.epoch &&
          raw.type === "event" &&
          raw.scope === p.deviceId &&
          raw.event?.type === "message" &&
          raw.event.sessionId === client.state.session?.id &&
          client.state.canAct &&
          !this.value.hasNewer
        )
          void this.reload(epoch);
      }),
    );
    transport.connect();
  }
  private async reload(epoch: number) {
    if (this.refresh) {
      this.refreshAgain = true;
      return this.refresh;
    }
    const task = (async () => {
      try {
        do {
          this.refreshAgain = false;
          await this.tasks(this.value.offset);
          if (epoch === this.epoch) await this.history("latest");
        } while (epoch === this.epoch && this.refreshAgain);
      } catch {
        if (epoch === this.epoch && this.value.phase === "connected")
          this.update({
            error: "无法读取任务，请检查电脑上的查看授权。",
            loading: false,
          });
      }
    })();
    this.refresh = task;
    void task.finally(() => {
      if (this.refresh === task) this.refresh = undefined;
    });
    return task;
  }
  async tasks(offset = 0) {
    const client = this.client,
      epoch = this.epoch,
      list = ++this.listEpoch;
    if (!client || !client.state.canAct) throw Error("Not connected");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw Error("Invalid page");
    this.update({ loading: true });
    try {
      const sessions = z
        .array(sessionSchema)
        .max(50)
        .parse(await client.request("session.list", { offset, limit: 50 }));
      if (epoch === this.epoch && list === this.listEpoch)
        this.update({
          sessions,
          offset,
          moreSessions: sessions.length === 50,
          loading: false,
        });
    } catch (e) {
      if (epoch === this.epoch && list === this.listEpoch)
        this.update({ loading: false, error: "无法读取任务列表，请重试。" });
      throw e;
    }
  }
  async select(sessionId: string) {
    if (!this.client?.state.canAct) throw Error("Not connected");
    const epoch = this.epoch;
    this.update({ loading: true, error: null });
    try {
      await this.client.request("session.resume", { sessionId });
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          error: "切换结果未确认。恢复连接后将以电脑的任务状态为准。",
        });
      throw error;
    } finally {
      if (epoch === this.epoch) this.update({ loading: false });
    }
  }
  async history(direction: "older" | "newer" | "latest" = "latest") {
    const client = this.client,
      epoch = this.epoch,
      sessionId = client?.state.session?.id,
      history = ++this.historyEpoch;
    if (!client || !client.state.canAct) return;
    if (!sessionId) {
      this.update({ messages: [], hasOlder: false, hasNewer: false });
      return;
    }
    const p: Record<string, unknown> = { sessionId, limit: 20 };
    if (direction === "older" && this.value.messages.length)
      p.before = this.value.messages[0]!.seq;
    if (direction === "newer" && this.value.messages.length)
      p.after = this.value.messages.at(-1)!.seq;
    this.update({ loading: true });
    try {
      const page = pageSchema.parse(await client.request("messages.read", p));
      if (
        page.items.some((row, i) => i > 0 && row.seq <= page.items[i - 1]!.seq)
      )
        throw Error("Invalid message order");
      if (
        epoch === this.epoch &&
        history === this.historyEpoch &&
        sessionId === client.state.session?.id
      )
        this.update({
          messages: page.items,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          loading: false,
        });
    } catch (error) {
      if (epoch === this.epoch && history === this.historyEpoch)
        this.update({ loading: false, error: "无法恢复任务内容，请重试。" });
      throw error;
    }
  }
  private async revoked(epoch: number) {
    if (epoch !== this.epoch) return;
    epoch = ++this.epoch;
    const p = this.pairing;
    this.stop();
    this.update({ ...empty("blocked"), error: "正在移除失效的设备连接…" });
    try {
      await this.credentials(async () => {
        await this.storage.erase();
        if (p) await this.storage.clear(pairingScope(p));
      });
      if (epoch === this.epoch) {
        this.pairing = undefined;
        this.update({
          ...empty("revoked"),
          error: "配对已撤销或失效，请在电脑上重新配对。",
        });
      }
    } catch {
      if (epoch === this.epoch)
        this.update({
          ...empty("blocked"),
          error: "无法移除失效凭据，请重试移除连接。",
        });
    }
  }
  suspend() {
    if (this.disposed) return;
    this.epoch++;
    this.stop();
    this.pendingPairing = undefined;
    this.update(empty("background"));
  }
  async forget() {
    const epoch = ++this.epoch,
      p = this.pairing;
    this.stop();
    this.pendingPairing = undefined;
    this.update({ ...empty("blocked"), error: "正在移除连接…" });
    try {
      await this.credentials(async () => {
        await this.storage.erase();
        if (p) await this.storage.clear(pairingScope(p));
      });
      if (epoch === this.epoch) {
        this.pairing = undefined;
        this.update(empty("unpaired"));
      }
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          ...empty("blocked"),
          error: "无法移除设备凭据，请重试。",
        });
      throw error;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.stop();
    this.listeners.clear();
  }
}
