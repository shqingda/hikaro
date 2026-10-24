import { ClientState, type ExecutionState } from "./index.ts";
import {
  rpcTransientMethods,
  type RpcMethod,
} from "../../protocol/src/contracts.ts";

export type ClientCommand = {
  id: string;
  scope: string;
  method: RpcMethod;
  params: Record<string, unknown>;
};
export interface RawTransport {
  send(frame: ClientCommand): void | Promise<void>;
  observe(fn: (frame: unknown) => void): () => void;
}
export type Intent = { id: string; method: RpcMethod };
export interface IntentStore {
  load(): Promise<Intent[]>;
  /** Must durably commit before resolving. Store IDs/methods, never prompt data. */
  save(intents: Intent[]): Promise<void>;
}
export type ConnectionOptions = {
  intents?: IntentStore;
  id(): string;
  /** Platform clock; cancellation must remove the scheduled callback. */
  schedule(fn: () => void, ms: number): () => void;
  timeoutMs?: number;
};

/** One view of a host. Reconnection retries reads only, never a user's mutation. */
export class ClientConnection {
  private view: ClientState;
  private initialization?: Promise<void>;
  private connectionAttempt = 0;
  private journalQueue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private active = false;
  private disposed = false;
  private syncing?: Promise<void>;
  private listeners = new Set<() => void>();
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cancel(): void;
    }
  >();
  private unobserve: () => void;
  error: string | null = null;
  constructor(
    readonly scope: string,
    private transport: RawTransport,
    private options: ConnectionOptions,
  ) {
    this.view = new ClientState(scope);
    this.unobserve = transport.observe((frame) => this.receive(frame));
  }
  get state(): ExecutionState {
    return this.view.state;
  }
  get receipts() {
    return this.view.receipts;
  }
  supports(method: RpcMethod): boolean {
    return this.view.supports(method);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view must not corrupt transport state. */
      }
    }
  }
  async connected(): Promise<void> {
    if (this.disposed) throw Error("Client is closed");
    this.disconnected();
    const attempt = this.connectionAttempt;
    if (!this.initialization) {
      const init = (async () => {
        if (this.options.intents)
          this.view.restoreIntents(await this.options.intents.load());
      })();
      this.initialization = init;
      void init.catch(() => {
        if (this.initialization === init) this.initialization = undefined;
      });
    }
    await this.initialization;
    if (this.disposed || attempt !== this.connectionAttempt)
      throw Error("Connection replaced");
    this.active = true;
    this.epoch = this.view.beginConnection();
    this.error = null;
    const epoch = this.epoch;
    this.notify();
    try {
      await this.request("hello", { protocolVersions: [2] });
      if (!this.active || epoch !== this.epoch)
        throw Error("Connection replaced");
      await this.synchronize();
      if (this.options.intents && epoch === this.epoch) await this.reconcile();
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = error instanceof Error ? error.message : String(error);
        this.disconnected();
      }
      throw error;
    }
  }
  disconnected(): void {
    this.connectionAttempt++;
    this.active = false;
    this.syncing = undefined;
    this.view.disconnected(this.epoch);
    for (const pending of this.pending.values()) {
      pending.cancel();
      pending.reject(Error("Connection lost; command outcome may be unknown"));
    }
    this.pending.clear();
    this.notify();
  }
  synchronize(attempt = 0): Promise<void> {
    if (attempt >= 3)
      return Promise.reject(
        Error("Snapshot did not converge; reconnect explicitly"),
      );
    if (this.syncing)
      return this.syncing.then(() => {
        if (this.active && this.view.needsSynchronization)
          return this.synchronize(attempt + 1);
      });
    const task = this.request("session.current").then(() => {});
    this.syncing = task;
    void task
      .finally(() => {
        if (this.syncing === task) this.syncing = undefined;
      })
      .catch(() => {});
    return task;
  }
  async reconcile(): Promise<void> {
    if (!this.view.supports("command.receipt"))
      throw Error("Host does not support durable receipt queries");
    for (const receipt of this.receipts.filter(
      (r) =>
        !rpcTransientMethods.has(r.method) &&
        ["unknown", "acknowledged"].includes(r.status),
    ))
      await this.request("command.receipt", { commandId: receipt.id });
    await this.persistIntents();
  }
  private persistIntents(): Promise<void> {
    if (!this.options.intents) return Promise.resolve();
    const save = () =>
      this.options.intents!.save(
        this.receipts
          .filter(
            (r) =>
              !rpcTransientMethods.has(r.method) &&
              !["completed", "failed"].includes(r.status),
          )
          .map((r) => ({ id: r.id, method: r.method })),
      );
    const task = this.journalQueue.then(save, save);
    this.journalQueue = task;
    return task;
  }
  async request(
    method: RpcMethod,
    params: Record<string, unknown> = {},
    options: { id?: string; beforeSend?: () => void } = {},
  ): Promise<unknown> {
    if (!this.active || this.disposed)
      return Promise.reject(Error("Not connected"));
    const recovery = [
      "hello",
      "session.current",
      "command.receipt",
      "cancel",
      "run.cancel",
      "approval.respond",
    ].includes(method);
    // A prompt acknowledgement can precede durable run completion. Refresh old
    // outcomes before admitting another mutation so completed runs release slots.
    // Recovery commands remain available even while outcome queries are blocked.
    if (
      !recovery &&
      !rpcTransientMethods.has(method) &&
      this.view.supports("command.receipt") &&
      this.receipts.some(
        (r) =>
          !rpcTransientMethods.has(r.method) &&
          ["acknowledged", "unknown"].includes(r.status),
      )
    ) {
      const epoch = this.epoch;
      await this.reconcile();
      if (!this.active || this.disposed || epoch !== this.epoch)
        throw Error(
          "Connection replaced before send; command was not replayed",
        );
    }
    if (this.pending.size >= (recovery ? 32 : 28))
      return Promise.reject(Error("Client request capacity exceeded"));
    let frame: ClientCommand;
    try {
      frame = this.view.command(
        options.id ?? this.options.id(),
        method,
        params,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      const cancel = this.options.schedule(() => {
        this.pending.delete(frame.id);
        this.view.timedOut(frame.id);
        this.notify();
        reject(Error("Request timed out; command outcome may be unknown"));
      }, this.options.timeoutMs ?? 30000);
      this.pending.set(frame.id, { resolve, reject, cancel });
      const failed = (error: unknown) => {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.cancel();
        this.view.timedOut(frame.id);
        this.notify();
        pending.reject(error instanceof Error ? error : Error(String(error)));
      };
      const epoch = this.epoch;
      const send = () => {
        if (!this.active || epoch !== this.epoch || !this.pending.has(frame.id))
          throw Error(
            "Connection replaced before send; command was not replayed",
          );
        // Recheck view-specific authority after journal/reconciliation awaits.
        options.beforeSend?.();
        return this.transport.send(frame);
      };
      try {
        if (!rpcTransientMethods.has(method) && this.options.intents)
          void this.persistIntents().then(send).catch(failed);
        else Promise.resolve(send()).catch(failed);
      } catch (error) {
        failed(error);
      }
      this.notify();
    }).then(async (result) => {
      if (!recovery && this.active && this.view.needsSynchronization)
        await this.synchronize();
      if (
        !rpcTransientMethods.has(method) &&
        this.active &&
        this.view.supports("command.receipt")
      )
        await this.request("command.receipt", { commandId: frame.id });
      return result;
    });
  }
  private receive(frame: unknown) {
    if (!this.active) return;
    try {
      this.view.receive(this.epoch, frame);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.disconnected();
      return;
    }
    if (
      frame &&
      typeof frame === "object" &&
      "type" in frame &&
      frame.type === "response" &&
      "id" in frame &&
      typeof frame.id === "string"
    ) {
      // A scope mismatch cannot complete a command even if IDs happen to match.
      if ("scope" in frame && frame.scope !== this.scope) return;
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        pending.cancel();
        if ("error" in frame && typeof frame.error === "string")
          pending.reject(Error(frame.error));
        else pending.resolve("result" in frame ? frame.result : undefined);
      }
    }
    this.notify();
    if (this.view.needsSynchronization && !this.syncing) {
      const epoch = this.epoch;
      void Promise.resolve()
        .then(() => {
          if (this.active && epoch === this.epoch) return this.synchronize();
        })
        .catch((error: unknown) => {
          if (epoch === this.epoch) {
            this.error = String(error);
            this.notify();
          }
        });
    }
  }
  close(): void {
    this.disconnected();
    this.disposed = true;
    this.unobserve();
    this.listeners.clear();
  }
}
