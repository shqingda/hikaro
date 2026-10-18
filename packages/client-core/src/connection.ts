import { ClientState, type ExecutionState } from "./index.ts";
import {
  rpcReadMethods,
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
export type ConnectionOptions = {
  id(): string;
  /** Platform clock; cancellation must remove the scheduled callback. */
  schedule(fn: () => void, ms: number): () => void;
  timeoutMs?: number;
};

/** One view of a host. Reconnection retries reads only, never a user's mutation. */
export class ClientConnection {
  private view: ClientState;
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
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = error instanceof Error ? error.message : String(error);
        this.disconnected();
      }
      throw error;
    }
  }
  disconnected(): void {
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
        if (this.active && this.view.state.syncRequired)
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
        !rpcReadMethods.has(r.method) &&
        ["unknown", "acknowledged"].includes(r.status),
    ))
      await this.request("command.receipt", { commandId: receipt.id });
  }
  request(
    method: RpcMethod,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.active || this.disposed)
      return Promise.reject(Error("Not connected"));
    const recovery = [
      "hello",
      "session.current",
      "command.receipt",
      "cancel",
      "approval.respond",
    ].includes(method);
    if (this.pending.size >= (recovery ? 32 : 28))
      return Promise.reject(Error("Client request capacity exceeded"));
    let frame: ClientCommand;
    try {
      frame = this.view.command(this.options.id(), method, params);
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
      try {
        Promise.resolve(this.transport.send(frame)).catch(failed);
      } catch (error) {
        failed(error);
      }
      this.notify();
    }).then(async (result) => {
      if (!recovery && this.active && this.view.state.syncRequired)
        await this.synchronize();
      if (
        !rpcReadMethods.has(method) &&
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
    if (
      this.view.state.connection === "connected" &&
      this.view.state.syncRequired &&
      !this.syncing
    ) {
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
