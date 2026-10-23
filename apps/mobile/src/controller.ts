import * as z from "zod";
import {
  MobileInspection,
  emptyInspection,
  type InspectionState,
} from "./inspection.ts";
import {
  MobileSteering,
  emptySteering,
  type SteeringState,
} from "./steering.ts";
import {
  MobileComposer,
  emptyComposer,
  type ComposerState,
  type DraftStore,
} from "./composer.ts";
import {
  rpcTransientMethods,
  CommandReceiptResult,
  RunCancelResult,
  type Permission,
  type RpcMethod,
} from "../../../packages/protocol/src/contracts.ts";
import type {
  CommandReceipt,
  ExecutionState,
} from "../../../packages/client-core/src/index.ts";
import {
  contentPage,
  contentRequestOffset,
  type ContentPage,
} from "./content.ts";
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
const snapshotSchema = z.object({
  session: sessionSchema,
  items: z.array(itemSchema).max(20),
  savedAt: z.number().finite().nonnegative(),
});
export type MobileSnapshot = z.infer<typeof snapshotSchema>;
export type MobileMessage = z.infer<typeof itemSchema>;
export type MobileSession = z.infer<typeof sessionSchema>;
export interface MobileStorage {
  read(): Promise<string | null>;
  write(credential: string): Promise<void>;
  erase(): Promise<void>;
  journal(scope: string): IntentStore;
  clear(scope: string): Promise<void>;
  drafts: DraftStore;
  snapshots: {
    load(scope: string): Promise<unknown>;
    save(scope: string, snapshot: MobileSnapshot): Promise<void>;
    clear(scope: string): Promise<void>;
  };
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
  "messages.search",
  "push.register",
  "messages.content",
  "changes.list",
  "changes.diff",
  "session.resume",
  "command.receipt",
  "approval.respond",
  "run.cancel",
  "prompt",
  "steer",
  "execution.hold",
  "execution.release",
  "execution.read",
  "execution.action",
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
  cacheClear: "idle" | "clearing" | "cleared" | "failed";
  unknown: number;
  sessionRole: ExecutionState["sessionRole"];
  canStopRun: boolean;
  canSend: boolean;
  canSteer: boolean;
  inspection: InspectionState;
  steering: SteeringState;
  composer: ComposerState;
  approvals: Permission[];
  receipts: CommandReceipt[];
  actionPending: string | null;
  actionNotice: string | null;
  content: {
    sessionId: string;
    seq: number;
    offset: number;
    page: ContentPage | null;
  } | null;
  contentLoading: boolean;
  contentError: string | null;
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
  cacheClear: "idle",
  unknown: 0,
  sessionRole: null,
  canStopRun: false,
  canSend: false,
  canSteer: false,
  inspection: emptyInspection(),
  steering: emptySteering(),
  composer: emptyComposer(),
  approvals: [],
  receipts: [],
  actionPending: null,
  actionNotice: null,
  content: null,
  contentLoading: false,
  contentError: null,
});
/** Only explicit, authority-checked operations expose mutation-capable transport. */
export class MobileController {
  private value = empty("unpaired");
  private listeners = new Set<() => void>();
  private epoch = 0;
  private pairingGeneration = 0;
  private historyEpoch = 0;
  private listEpoch = 0;
  private contentEpoch = 0;
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
  private draftIdentity = 0;
  private cacheVersion = 0;
  private cacheClearEpoch = 0;
  private composer: MobileComposer;
  readonly steering: MobileSteering;
  readonly inspection: MobileInspection;
  constructor(
    private storage: MobileStorage,
    private options: MobileOptions,
  ) {
    this.inspection = new MobileInspection((inspection) => {
      if (!this.disposed) this.update({ inspection });
    });
    this.steering = new MobileSteering((steering) => {
      if (!this.disposed) this.update({ steering });
    }, options.schedule);
    this.composer = new MobileComposer(
      {
        load: (scope, id) =>
          this.credentials(() => this.storage.drafts.load(scope, id)),
        save: (scope, record) => {
          const identity = this.draftIdentity;
          return this.credentials(async () => {
            if (identity === this.draftIdentity)
              await this.storage.drafts.save(scope, record);
          });
        },
      },
      (composer) => {
        if (
          !this.disposed &&
          !["background", "blocked", "revoked", "unpaired"].includes(
            this.value.phase,
          )
        )
          this.update({ composer });
      },
    );
  }
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
    this.inspection.bind(null);
    this.steering.bind(null);
    this.composer.hide();
    this.contentEpoch++;
    this.value = {
      ...this.value,
      content: null,
      contentLoading: false,
      contentError: null,
      approvals: [],
      sessionRole: null,
      canStopRun: false,
      canSend: false,
      canSteer: false,
      actionPending: null,
      actionNotice: null,
    };
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
    this.pairingGeneration++;
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
        // Erasing credentials can finish after backgrounding fences forget's UI update.
        // An unpaired view must also retire the previous in-memory identity.
        this.pairing = undefined;
        this.pairingGeneration++;
        this.draftIdentity++;
        this.composer.bind(null);
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
          phase: "error",
          error: "无法读取或验证连接。请重试，或移除后重新配对。",
        });
    }
  }
  private async connect(p: Pairing, epoch: number) {
    this.pairing = p;
    this.composer.bind(pairingScope(p));
    this.update({
      phase: "connecting",
      review: null,
      deviceId: p.deviceId,
      relay: validateRelay(p.relay),
      error: null,
    });
    await this.composer.select();
    if (epoch !== this.epoch || this.disposed) return;
    this.update({ session: this.composer.state.record?.session ?? null });
    try {
      const saved = await this.credentials(() =>
        this.storage.snapshots.load(pairingScope(p)),
      );
      if (epoch !== this.epoch || this.disposed) return;
      if (saved !== null) {
        const cached = snapshotSchema.parse(saved);
        if (
          !this.value.session ||
          this.value.session.id === cached.session.id
        ) {
          if (!this.composer.state.record)
            await this.composer.select(cached.session);
          if (epoch !== this.epoch || this.disposed) return;
          this.update({ session: cached.session, messages: cached.items });
        }
      }
    } catch {
      // Cached display data is optional; a corrupt cache must not block reconnecting.
    }
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
            throw Error("Mobile operation is not supported");
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
        if (
          s.canAct &&
          this.value.session &&
          this.value.session.id !== current
        ) {
          // An authoritative selection/access change invalidates the old offline copy.
          this.cacheVersion++;
          void this.credentials(async () => {
            if (epoch === this.epoch)
              await this.storage.snapshots.clear(pairingScope(p));
          }).catch(() => {
            if (epoch === this.epoch)
              this.update({
                error: "未能清除旧任务的本机缓存，请移除连接后重试。",
              });
          });
        }
        if (restored || selected !== current) this.closeMessage();
        if (selected !== current) {
          this.historyEpoch++;
          this.update({
            messages: [],
            hasOlder: false,
            hasNewer: false,
            actionNotice: null,
          });
        }
        selected = current;
        ready = s.canAct;
        this.inspection.bind(s.canAct && s.session ? client : null);
        const control =
          s.canAct &&
          !!s.session &&
          ["owner", "control"].includes(s.sessionRole ?? "");
        this.steering.bind(
          control &&
            [
              "execution.hold",
              "execution.release",
              "execution.read",
              "execution.action",
              "command.receipt",
            ].every((method) => client.supports(method as RpcMethod))
            ? client
            : null,
        );
        this.update(
          {
            phase: s.canAct
              ? "connected"
              : s.connection === "offline"
                ? "offline"
                : "connecting",
            session: s.canAct || s.session ? s.session : this.value.session,
            stream: s.stream,
            busy: s.busy,
            streamTruncated: s.streamTruncated,
            runId: s.runId,
            runStatus: s.runStatus,
            sessionRole: s.sessionRole,
            canStopRun:
              s.canAct &&
              client.supports("run.cancel") &&
              s.busy &&
              s.runStatus === "running" &&
              !!s.runId &&
              ["owner", "control"].includes(s.sessionRole ?? ""),
            canSend:
              s.canAct &&
              client.supports("prompt") &&
              client.supports("command.receipt") &&
              !!s.session &&
              ["owner", "control"].includes(s.sessionRole ?? ""),
            canSteer:
              control &&
              client.supports("steer") &&
              client.supports("command.receipt"),
            approvals: s.canAct ? s.approvals : [],
            receipts: client.receipts.filter((r) =>
              [
                "approval.respond",
                "run.cancel",
                "prompt",
                "steer",
                "execution.action",
              ].includes(r.method),
            ),
            error: null,
            unknown: client.receipts.filter(
              (r) =>
                r.status === "unknown" && !rpcTransientMethods.has(r.method),
            ).length,
          },
          false,
        );
        if (restored) {
          void this.reload(epoch);
          void (async () => {
            if (this.composer.state.record?.session.id !== current)
              await this.composer.select(s.session);
            if (epoch === this.epoch) await this.reconcileDraft();
          })().catch(() => {});
        }
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
      if (epoch === this.epoch && list === this.listEpoch) {
        this.update({
          sessions,
          offset,
          moreSessions: sessions.length === 50,
          loading: false,
        });
        return true;
      }
      return false;
    } catch (e) {
      if (epoch === this.epoch && list === this.listEpoch)
        this.update({ loading: false, error: "无法读取任务列表，请重试。" });
      throw e;
    }
  }
  async select(sessionId: string) {
    if (this.value.actionPending) throw Error("A decision is pending");
    if (!this.client?.state.canAct) throw Error("Not connected");
    await this.composer.flush();
    if (!this.client?.state.canAct) throw Error("Not connected");
    this.closeMessage();
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
  editDraft(sessionId: string, text: string) {
    if (
      this.disposed ||
      !this.pairing ||
      !["connected", "offline", "connecting", "error"].includes(
        this.value.phase,
      )
    )
      throw Error("Draft unavailable");
    if (this.value.session?.id !== sessionId)
      throw Error("Draft selection changed");
    this.composer.edit(sessionId, text);
  }
  saveDraft() {
    return this.composer.retrySave();
  }
  restoreDraft(sessionId: string) {
    return this.composer.restoreDraft(sessionId);
  }
  async sendDraft(sessionId: string, method: "prompt" | "steer" = "prompt") {
    const client = this.client,
      epoch = this.epoch;
    const guard = () => {
      if (
        epoch !== this.epoch ||
        client !== this.client ||
        !client?.state.canAct ||
        client.state.session?.id !== sessionId ||
        !["owner", "control"].includes(client.state.sessionRole ?? "") ||
        !client.supports(method) ||
        !client.supports("command.receipt")
      )
        throw Error(
          "Current session control permission required; selection changed or offline",
        );
    };
    guard();
    const id = this.options.id();
    await this.composer.send(
      sessionId,
      id,
      (text) => {
        guard();
        return client!.request(
          method,
          { sessionId, text },
          { id, beforeSend: guard },
        );
      },
      method,
    );
  }
  async reconcileDraft() {
    const client = this.client,
      epoch = this.epoch;
    if (!client?.state.canAct || !client.supports("command.receipt")) return;
    const method = this.composer.state.record?.submission?.method ?? "prompt";
    await this.composer.reconcile(async (id) => {
      const result = await client.request("command.receipt", { commandId: id });
      if (epoch !== this.epoch) throw Error("Connection changed");
      const receipt = CommandReceiptResult.parse(result).receipt;
      if (!receipt) return "unknown";
      if (
        receipt.id !== id ||
        receipt.method !== method ||
        receipt.scope !== client.scope
      )
        throw Error("Receipt identity mismatch");
      // The durable claim precedes enqueueing. Only an RPC acknowledgement or
      // completed receipt proves acceptance; an accepted claim alone retains text.
      return receipt.status === "accepted" ? "pending" : receipt.status;
    });
  }
  async respondApproval(id: string, allow: boolean) {
    const client = this.client,
      epoch = this.epoch;
    const state = client?.state;
    if (
      !client ||
      !state?.canAct ||
      !state.session ||
      !["owner", "control"].includes(state.sessionRole ?? "")
    ) {
      this.update({
        actionNotice: "请先恢复连接，并确认电脑已授予当前任务的控制权限。",
      });
      throw Error("Current session control permission required");
    }
    if (this.value.actionPending) {
      this.update({ actionNotice: "上一项操作仍在等待回执，请先核对结果。" });
      throw Error("A decision is pending");
    }
    if (
      !state.approvals.some(
        (a) =>
          a.id === id &&
          (a.authoritySessionId ?? a.sessionId) === state.session!.id,
      )
    ) {
      this.update({
        actionNotice: "这项审批已失效或不属于当前任务，请查看最新请求。",
      });
      throw Error("Approval expired or belongs to another task");
    }
    this.update({ actionPending: id, actionNotice: null });
    try {
      await client.request("approval.respond", {
        id,
        allow,
        sessionId: state.session.id,
      });
      if (epoch === this.epoch)
        this.update({
          actionNotice: "电脑已收到决定，工具结果以任务记录为准。",
        });
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          actionNotice:
            "决定未确认或已失效。请核对回执与电脑状态，不会自动重发。",
        });
      throw error;
    } finally {
      if (epoch === this.epoch) this.update({ actionPending: null });
    }
  }
  async stopRun(sessionId: string, runId: string) {
    const client = this.client,
      epoch = this.epoch,
      state = client?.state;
    if (
      !client ||
      !state?.canAct ||
      !["owner", "control"].includes(state.sessionRole ?? "")
    ) {
      this.update({
        actionNotice: "请先恢复连接，并确认电脑已授予当前任务的控制权限。",
      });
      throw Error("Current session control permission required");
    }
    if (!client.supports("run.cancel")) {
      this.update({
        actionNotice: "请更新电脑上的 Hikaro 后，再从手机停止运行。",
      });
      throw Error("Host does not support run cancellation");
    }
    if (
      state.session?.id !== sessionId ||
      state.runId !== runId ||
      !state.busy ||
      state.runStatus !== "running"
    ) {
      this.update({
        actionNotice: "这次运行已结束或任务已变化，原停止确认已失效。",
      });
      throw Error("Run confirmation expired");
    }
    if (this.value.actionPending) throw Error("An operation is pending");
    this.update({ actionPending: runId, actionNotice: "正在发送停止请求…" });
    try {
      const result = RunCancelResult.parse(
        await client.request("run.cancel", { sessionId, runId }),
      );
      if (result.runId !== runId)
        throw Error("Stop receipt does not match the requested run");
      if (epoch === this.epoch)
        this.update({
          actionNotice: "电脑已收到停止请求，实际终态以运行状态为准。",
        });
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          actionNotice:
            "停止结果未确认或目标已失效。请核对回执与运行状态，不会自动重发。",
        });
      throw error;
    } finally {
      if (epoch === this.epoch) this.update({ actionPending: null });
    }
  }
  async reconcileActions() {
    const client = this.client,
      epoch = this.epoch;
    if (!client?.state.canAct) {
      this.update({ actionNotice: "请先恢复连接，再核对操作回执。" });
      throw Error("Not connected");
    }
    if (this.value.actionPending) throw Error("A decision is pending");
    this.update({
      actionPending: "receipts",
      actionNotice: "正在核对操作回执…",
    });
    try {
      await client.reconcile();
      if (epoch === this.epoch)
        this.update({
          actionNotice: "回执已核对。仍显示结果未知的操作不会自动重发。",
        });
    } catch (error) {
      if (epoch === this.epoch)
        this.update({
          actionNotice: "暂时无法核对回执，请恢复连接后重试核对。",
        });
      throw error;
    } finally {
      if (epoch === this.epoch) this.update({ actionPending: null });
    }
  }
  closeMessage() {
    this.contentEpoch++;
    this.update({ content: null, contentLoading: false, contentError: null });
  }
  async readMessage(seq: number, offset = 0) {
    const client = this.client,
      epoch = this.epoch,
      sessionId = client?.state.session?.id;
    if (!client?.state.canAct || !sessionId)
      throw Error("Not connected to a task");
    if (!Number.isSafeInteger(seq) || seq < 0) throw Error("Invalid message");
    const requestOffset = contentRequestOffset(offset),
      read = ++this.contentEpoch;
    const current = () =>
      epoch === this.epoch &&
      read === this.contentEpoch &&
      client === this.client &&
      sessionId === client.state.session?.id;
    this.update({
      content: { sessionId, seq, offset, page: null },
      contentLoading: true,
      contentError: null,
    });
    try {
      const raw = await client.request("messages.content", {
        sessionId,
        seq,
        field: "text",
        offset: requestOffset,
        limit: 8192,
      });
      if (current())
        this.update({
          content: { sessionId, seq, offset, page: contentPage(raw, offset) },
          contentLoading: false,
        });
    } catch (error) {
      if (current())
        this.update({
          contentLoading: false,
          contentError: "无法读取这段正文。请检查查看授权或重试。",
        });
      throw error;
    }
  }
  async history(direction: "older" | "newer" | "latest" = "latest") {
    const client = this.client,
      epoch = this.epoch,
      sessionId = client?.state.session?.id,
      history = ++this.historyEpoch,
      cacheVersion = this.cacheVersion;
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
      ) {
        this.update({
          messages: page.items,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          loading: false,
        });
        const pairing = this.pairing;
        const session = this.value.session;
        if (pairing && session?.id === sessionId) {
          try {
            await this.credentials(async () => {
              if (
                epoch !== this.epoch ||
                history !== this.historyEpoch ||
                cacheVersion !== this.cacheVersion
              )
                return;
              await this.storage.snapshots.save(pairingScope(pairing), {
                session,
                items: page.items,
                savedAt: Date.now(),
              });
            });
          } catch {
            if (epoch === this.epoch && history === this.historyEpoch)
              this.update({ error: "内容已读取，但未能保存本机历史缓存。" });
          }
        }
      }
    } catch (error) {
      if (epoch === this.epoch && history === this.historyEpoch)
        this.update({ loading: false, error: "无法恢复任务内容，请重试。" });
      throw error;
    }
  }
  get notificationIdentity() {
    return this.pairing &&
      !this.disposed &&
      !["unpaired", "review", "blocked", "revoked"].includes(this.value.phase)
      ? JSON.stringify([this.pairingGeneration, pairingScope(this.pairing)])
      : null;
  }
  async refreshNotificationTasks(identity: string): Promise<boolean> {
    const epoch = this.epoch;
    if (
      !identity ||
      identity !== this.notificationIdentity ||
      this.value.phase !== "connected"
    )
      return false;
    const fresh = await this.tasks(0);
    return (
      fresh &&
      epoch === this.epoch &&
      identity === this.notificationIdentity &&
      this.value.phase === "connected"
    );
  }
  get pushIdentity() {
    return this.pairing && this.value.phase === "connected"
      ? pairingScope(this.pairing)
      : null;
  }
  matchesPushHost(hostId: unknown) {
    return typeof hostId === "string" && this.pairing?.hostId === hostId;
  }
  async configurePush(token: string | null, identity = this.pushIdentity) {
    if (
      token !== null &&
      !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(token)
    )
      throw Error("Invalid push token");
    const client = this.client,
      epoch = this.epoch;
    const current = () => {
      if (
        !identity ||
        identity !== this.pushIdentity ||
        !client ||
        client !== this.client ||
        epoch !== this.epoch ||
        this.value.phase !== "connected"
      )
        throw Error("通知连接已变化，请重新操作。");
    };
    current();
    if (!client!.supports("push.register"))
      throw Error("电脑端尚不支持通知设置，请升级后重试。");
    const result = await client!.request(
      "push.register",
      { token },
      { beforeSend: current },
    );
    current();
    if (
      !result ||
      typeof result !== "object" ||
      !("ok" in result) ||
      result.ok !== true
    )
      throw Error("通知设置未确认，请重试。");
  }
  async clearHistoryCache() {
    const pairing = this.pairing;
    if (
      !pairing ||
      this.disposed ||
      this.value.cacheClear === "clearing" ||
      !["connected", "offline", "connecting", "error"].includes(
        this.value.phase,
      )
    )
      return;
    const epoch = this.epoch,
      request = ++this.cacheClearEpoch;
    const current = () =>
      !this.disposed &&
      epoch === this.epoch &&
      pairing === this.pairing &&
      request === this.cacheClearEpoch;
    this.cacheVersion++;
    this.update({ cacheClear: "clearing" });
    try {
      await this.credentials(async () => {
        if (current())
          await this.storage.snapshots.clear(pairingScope(pairing));
      });
      if (current())
        this.update({
          cacheClear: "cleared",
          ...(this.value.phase !== "connected"
            ? { messages: [], hasOlder: false, hasNewer: false }
            : {}),
        });
    } catch (error) {
      if (current()) this.update({ cacheClear: "failed" });
      throw error;
    }
  }
  private async revoked(epoch: number) {
    if (epoch !== this.epoch) return;
    epoch = ++this.epoch;
    this.pairingGeneration++;
    const p = this.pairing;
    this.draftIdentity++;
    this.composer.bind(null);
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
    this.pairingGeneration++;
    const epoch = ++this.epoch,
      p = this.pairing;
    this.draftIdentity++;
    this.composer.bind(null);
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
