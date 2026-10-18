import {
  ApprovalFrame,
  CurrentSession,
  CommandReceiptResult,
  EventFrame,
  HelloResult,
  ResolvedFrame,
  ResponseFrame,
  InvalidatedFrame,
  type RpcMethod,
  type ScopedFrame,
  type Permission,
  rpcMethods,
  rpcReadMethods as reads,
} from "../../protocol/src/contracts.ts";

const MAX_RECEIPTS = 64;
const MAX_BUFFER = 128;
const MAX_FRAME = 1_048_576;
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export type CommandReceipt = {
  id: string;
  method: RpcMethod;
  status: "pending" | "acknowledged" | "completed" | "failed" | "unknown";
  durableStatus?: "accepted" | "completed" | "failed" | "unknown";
  runId?: string;
  operationId?: string;
  error?: string;
};
export type ExecutionState = {
  connection: "offline" | "connecting" | "connected";
  syncRequired: boolean;
  canAct: boolean;
  hostInstanceId: string | null;
  session: CurrentSession["session"];
  sessionRole: "owner" | "view" | "control" | null;
  cursor: number;
  revision: number;
  busy: boolean;
  stream: string;
  streamTruncated: boolean;
  runId: string | null;
  runStatus:
    "idle" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  approvals: Permission[];
  events: Array<{ seq: number; type: string; timestamp: number }>;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Ordered, transport-independent execution state. Preparing a command never sends it. */
export class ClientState {
  private epoch = 0;
  private helloId?: string;
  private snapshotId?: string;
  private methods = new Set<RpcMethod>();
  private hostNegotiated = false;
  private commands = new Map<string, CommandReceipt>();
  private receiptQueries = new Map<string, string>();
  private buffered: ScopedFrame[] = [];
  private bufferChars = 0;
  private overflow = false;
  private value: ExecutionState = {
    connection: "offline",
    syncRequired: true,
    canAct: false,
    hostInstanceId: null,
    session: null,
    sessionRole: null,
    cursor: 0,
    revision: 0,
    busy: false,
    stream: "",
    streamTruncated: false,
    runId: null,
    runStatus: "idle",
    approvals: [],
    events: [],
  };
  constructor(readonly scope: string) {
    if (!scope || scope.length > 80) throw Error("Invalid client scope");
  }
  get state(): ExecutionState {
    return copy(this.value);
  }
  get receipts(): CommandReceipt[] {
    return [...this.commands.values()].map(copy);
  }
  supports(method: RpcMethod): boolean {
    return this.methods.has(method);
  }
  receipt(id: string): CommandReceipt | undefined {
    const value = this.commands.get(id);
    return value && copy(value);
  }

  restoreIntents(intents: Array<{ id: string; method: RpcMethod }>): void {
    if (this.value.connection !== "offline" || this.commands.size)
      throw Error("Restore intents before connecting");
    if (intents.length > MAX_RECEIPTS - 4)
      throw Error("Intent journal capacity exceeded");
    const seen = new Set<string>();
    for (const intent of intents) {
      if (
        !intent ||
        typeof intent.id !== "string" ||
        !intent.id ||
        intent.id.length > 128 ||
        !rpcMethods.includes(intent.method) ||
        reads.has(intent.method) ||
        seen.has(intent.id)
      )
        throw Error("Invalid intent journal");
      seen.add(intent.id);
    }
    for (const intent of intents)
      this.commands.set(intent.id, {
        id: intent.id,
        method: intent.method,
        status: "unknown",
      });
  }
  beginConnection(): number {
    this.disconnected(this.epoch);
    this.epoch++;
    this.value.connection = "connecting";
    this.methods.clear();
    this.hostNegotiated = false;
    this.helloId = undefined;
    this.snapshotId = undefined;
    this.buffered = [];
    this.bufferChars = 0;
    this.overflow = false;
    return this.epoch;
  }
  disconnected(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.value.connection = "offline";
    this.invalidate();
    for (const command of this.commands.values())
      if (command.status === "pending") command.status = "unknown";
  }
  timedOut(id: string): void {
    const command = this.commands.get(id);
    if (command?.status === "pending") command.status = "unknown";
    if (id === this.helloId || id === this.snapshotId) this.invalidate();
  }
  private invalidate(): void {
    this.value.syncRequired = true;
    this.value.canAct = false;
  }

  command(
    id: string,
    method: RpcMethod,
    params: Record<string, unknown> = {},
  ): {
    id: string;
    scope: string;
    method: RpcMethod;
    params: Record<string, unknown>;
  } {
    if (!id || id.length > 128) throw Error("Invalid command ID");
    if (this.commands.has(id))
      throw Error(
        "Command ID already used; unknown outcomes must not be replayed",
      );
    if (this.value.connection === "offline")
      throw Error("Client must connect before sending commands");
    if (method !== "hello" && !this.methods.has(method))
      throw Error("Handshake required or method unavailable");
    if (
      method !== "hello" &&
      method !== "session.current" &&
      method !== "command.receipt" &&
      !this.value.canAct
    )
      throw Error("A current snapshot is required before sending commands");
    if (
      (method === "hello" &&
        this.helloId &&
        this.commands.get(this.helloId)?.status === "pending") ||
      (method === "session.current" &&
        this.snapshotId &&
        this.commands.get(this.snapshotId)?.status === "pending")
    )
      throw Error("Synchronization request already pending");
    const frame = { id, scope: this.scope, method, params: copy(params) };
    if (utf8Bytes(JSON.stringify(frame)) > MAX_FRAME)
      throw Error("Command capacity exceeded");
    if (
      !reads.has(method) &&
      [...this.commands.values()].filter(
        (command) =>
          !reads.has(command.method) &&
          command.status !== "completed" &&
          command.status !== "failed",
      ).length >=
        MAX_RECEIPTS - 4
    )
      throw Error(
        "Command receipt capacity exceeded; synchronization slots reserved",
      );
    if (method === "command.receipt") {
      if (
        typeof params.commandId !== "string" ||
        !params.commandId ||
        params.commandId.length > 128
      )
        throw Error("Invalid receipt command ID");
    }
    if (this.commands.size >= MAX_RECEIPTS) {
      const removable = [...this.commands.values()].find(
        (c) =>
          c.status === "completed" ||
          c.status === "failed" ||
          (c.status !== "pending" && reads.has(c.method)),
      );
      if (!removable)
        throw Error(
          "Command receipt capacity exceeded; unresolved outcomes retained",
        );
      this.commands.delete(removable.id);
      this.receiptQueries.delete(removable.id);
    }
    this.commands.set(id, { id, method, status: "pending" });
    if (method === "command.receipt")
      this.receiptQueries.set(id, params.commandId as string);
    if (method === "hello") {
      this.helloId = id;
      this.snapshotId = undefined;
      this.methods.clear();
      this.value.connection = "connecting";
      this.invalidate();
    }
    if (method === "session.current") {
      this.snapshotId = id;
      this.invalidate();
    }
    return frame;
  }

  /** Feed raw frames in transport order; epoch fences callbacks from old connections. */
  receive(epoch: number, raw: unknown): void {
    if (epoch !== this.epoch || this.value.connection === "offline") return;
    if (!raw || typeof raw !== "object") return;
    const frame = raw as Record<string, unknown>;
    if (frame.scope !== undefined && frame.scope !== this.scope) return;
    if (
      this.hostNegotiated &&
      frame.hostInstanceId !== undefined &&
      frame.hostInstanceId !== this.value.hostInstanceId
    ) {
      this.invalidate();
      throw Error("RPC host instance identity changed; reconnect required");
    }
    if (
      !this.hostNegotiated &&
      (frame.type !== "response" || frame.id !== this.helloId)
    )
      return;
    if (
      frame.type === "operation.completed" &&
      frame.method === "session.compact"
    ) {
      this.invalidate();
      return;
    }
    if (
      ![
        "response",
        "event",
        "approval",
        "approval.resolved",
        "session.invalidated",
      ].includes(String(frame.type))
    )
      return;
    try {
      const chars = utf8Bytes(JSON.stringify(raw));
      if (chars > MAX_FRAME) throw Error("Incoming frame capacity exceeded");
      if (frame.type === "response") {
        this.response(ResponseFrame.parse(raw));
        return;
      }
      const parsed =
        frame.type === "event"
          ? EventFrame.parse(raw)
          : frame.type === "approval"
            ? ApprovalFrame.parse(raw)
            : frame.type === "session.invalidated"
              ? InvalidatedFrame.parse(raw)
              : ResolvedFrame.parse(raw);
      if (this.value.syncRequired) {
        if (
          this.buffered.length >= MAX_BUFFER ||
          this.bufferChars + chars > MAX_FRAME
        ) {
          this.buffered = [];
          this.bufferChars = 0;
          this.overflow = true;
        } else if (!this.overflow) {
          this.buffered.push(copy(parsed));
          this.bufferChars += chars;
        }
        return;
      }
      this.apply(parsed);
    } catch (error) {
      this.invalidate();
      throw Error(
        error instanceof Error && /capacity/.test(error.message)
          ? error.message
          : "Invalid RPC state frame",
      );
    }
  }
  private response(frame: ReturnType<typeof ResponseFrame.parse>): void {
    const command = this.commands.get(frame.id);
    if (
      !command ||
      (command.status !== "pending" && command.status !== "unknown")
    )
      return;
    command.status = frame.error === undefined ? "acknowledged" : "failed";
    if (frame.error !== undefined) {
      command.error = frame.error;
      return;
    }
    if (command.method === "hello" && frame.id === this.helloId) {
      const hello = HelloResult.parse(frame.result);
      if (
        frame.hostInstanceId !== undefined &&
        frame.hostInstanceId !== hello.hostInstanceId
      )
        throw Error("Invalid handshake host identity");
      if (
        this.hostNegotiated &&
        (hello.hostInstanceId ?? null) !== this.value.hostInstanceId
      )
        throw Error("Invalid handshake host identity");
      if (
        !hello.methods.includes("session.current") ||
        !hello.methods.includes("hello")
      )
        throw Error("Invalid handshake methods");
      this.methods = new Set(
        rpcMethods.filter((method) => hello.methods.includes(method)),
      );
      this.value.connection = "connected";
      this.value.hostInstanceId = hello.hostInstanceId ?? null;
      this.hostNegotiated = true;
    } else if (
      command.method === "session.current" &&
      frame.id === this.snapshotId
    ) {
      const snapshot = CurrentSession.parse(frame.result);
      if (
        snapshot.hostInstanceId !== undefined &&
        snapshot.hostInstanceId !== this.value.hostInstanceId
      )
        throw Error("Invalid snapshot host identity");
      const pending = this.buffered;
      const overflow = this.overflow;
      this.buffered = [];
      this.bufferChars = 0;
      this.overflow = false;
      Object.assign(this.value, snapshot, {
        hostInstanceId: this.value.hostInstanceId,
        sessionRole: snapshot.sessionRole ?? null,
        runId: snapshot.runId ?? null,
        runStatus: snapshot.runStatus ?? (snapshot.busy ? "unknown" : "idle"),
        events: [],
        syncRequired: overflow,
        canAct: !overflow,
      });
      if (!overflow)
        for (const event of pending) {
          if (event.revision <= snapshot.revision) continue;
          this.apply(event);
          if (this.value.syncRequired) break;
        }
    } else if (command.method === "command.receipt") {
      const id = this.receiptQueries.get(command.id);
      const target = id && this.commands.get(id);
      if (!target || !["unknown", "acknowledged"].includes(target.status))
        return;
      const { receipt: durable } = CommandReceiptResult.parse(frame.result);
      if (!durable) return;
      if (
        durable.id !== target.id ||
        durable.scope !== this.scope ||
        durable.method !== target.method
      )
        throw Error("Durable command receipt identity mismatch");
      target.durableStatus = durable.status;
      target.runId = durable.runId;
      target.operationId = durable.operationId;
      target.error = durable.error;
      target.status =
        durable.status === "accepted" ? "acknowledged" : durable.status;
    } else if (
      [
        "session.create",
        "session.resume",
        "session.fork",
        "session.compact",
        "session.rename",
        "session.access",
        "session.delete",
        "model.set",
        "client.detach",
      ].includes(command.method)
    ) {
      this.invalidate();
    }
  }
  private apply(frame: ScopedFrame): void {
    if (frame.revision <= this.value.revision) return;
    if (frame.revision !== this.value.revision + 1) {
      this.invalidate();
      return;
    }
    this.value.revision = frame.revision;
    if (frame.type === "session.invalidated") {
      this.invalidate();
      return;
    }
    if (frame.type === "approval") {
      const next = this.value.approvals.filter(
        (a) => a.id !== frame.request.id,
      );
      next.push(copy(frame.request));
      if (next.length > 64 || utf8Bytes(JSON.stringify(next)) > MAX_FRAME)
        throw Error("Approval capacity exceeded");
      this.value.approvals = next;
      return;
    }
    if (frame.type === "approval.resolved") {
      this.value.approvals = this.value.approvals.filter(
        (a) => a.id !== frame.id,
      );
      return;
    }
    const event = frame.event;
    if (
      event.sessionId !== this.value.session?.id ||
      event.seq <= this.value.cursor
    )
      return;
    this.value.cursor = event.seq;
    this.value.events.push({
      seq: event.seq,
      type: event.type,
      timestamp: event.timestamp,
    });
    if (this.value.events.length > 64) this.value.events.shift();
    if (event.type === "run.start") {
      this.value.busy = true;
      this.value.runStatus = "running";
      this.value.runId =
        typeof event.data.runId === "string" ? event.data.runId : null;
      this.value.stream = "";
      this.value.streamTruncated = false;
    } else if (event.type === "text.delta") {
      if (typeof event.data.text !== "string")
        throw Error("Invalid text delta");
      const stream = this.value.stream + event.data.text;
      this.value.streamTruncated ||= stream.length > 100000;
      this.value.stream = stream.slice(-100000);
    } else if (
      event.type === "message" &&
      event.data.message &&
      typeof event.data.message === "object" &&
      "role" in event.data.message &&
      event.data.message.role === "assistant"
    ) {
      this.value.stream = "";
      this.value.streamTruncated = false;
    } else if (event.type === "run.end") {
      this.value.busy = false;
      const status = event.data.status;
      this.value.runStatus =
        status === "completed" || status === "failed" || status === "cancelled"
          ? status
          : "unknown";
    }
  }
}
