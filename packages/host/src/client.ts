import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { JsonLines, Command } from "../../protocol/src/index.ts";
import { hostEndpoint, readDescriptor, type HostEndpoint } from "./endpoint.ts";

/** Reconnects the channel, never an in-flight command. close() detaches only. */
export class SharedHostClient {
  private socket?: Socket;
  private observers = new Set<(frame: any) => void>();
  private listeners = new Set<(frame: any) => void>();
  private connections = new Set<(connected: boolean) => void>();
  private pending = new Map<
    string,
    {
      resolve(v: any): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stopped = false;
  private replaced = false;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private ready = false;
  private attempts = 0;
  readonly scope: string;
  private constructor(
    readonly endpoint: HostEndpoint,
    readonly mode: "local" | "bridge",
    readonly clientId: string,
  ) {
    this.scope = "local:" + clientId;
  }
  static async connect(options: {
    cwd: string;
    home?: string;
    mode?: "local" | "bridge";
    clientId?: string;
  }) {
    const client = new SharedHostClient(
      await hostEndpoint(options),
      options.mode ?? "local",
      options.clientId ?? randomUUID(),
    );
    try {
      await client.dial();
      return client;
    } catch (e) {
      await client.close();
      throw Error(
        `Shared host unavailable; start --host for this --cwd and --home. ${String(e)}`,
      );
    }
  }
  observe(fn: (frame: any) => void) {
    this.observers.add(fn);
    return () => {
      this.observers.delete(fn);
    };
  }
  subscribe(fn: (frame: any) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onConnection(fn: (connected: boolean) => void) {
    this.connections.add(fn);
    return () => {
      this.connections.delete(fn);
    };
  }
  private status(connected: boolean) {
    this.ready = connected;
    for (const fn of this.connections)
      try {
        fn(connected);
      } catch {}
  }
  private async dial(): Promise<void> {
    const generation = ++this.generation;
    const descriptor = await readDescriptor(this.endpoint);
    if (this.stopped || generation !== this.generation)
      throw Error("Connection replaced");
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint.socket);
      this.socket = socket;
      let attached = false;
      const timer = setTimeout(
        () => socket.destroy(Error("Host handshake timed out")),
        5000,
      );
      const parser = new JsonLines((raw) => {
        if (generation !== this.generation) return;
        const frame = raw as any;
        if (!attached) {
          if (
            frame.type !== "attached" ||
            frame.hostInstanceId !== descriptor.instanceId ||
            (this.mode === "local" && frame.scope !== this.scope)
          )
            throw Error("Invalid host handshake");
          clearTimeout(timer);
          attached = true;
          this.attempts = 0;
          this.status(true);
          resolve();
          return;
        }
        if (frame.type === "connection.replaced") this.replaced = true;
        for (const fn of this.observers)
          try {
            fn(frame);
          } catch {}
        if (frame.type === "response") {
          const key = (frame.scope ?? this.scope) + "\0" + frame.id;
          const pending = this.pending.get(key);
          if (pending) {
            this.pending.delete(key);
            clearTimeout(pending.timer);
            frame.error
              ? pending.reject(Error(frame.error))
              : pending.resolve(frame.result);
          }
        } else
          for (const fn of this.listeners)
            try {
              fn(frame);
            } catch {}
      });
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({
            type: "attach",
            mode: this.mode,
            clientId: this.clientId,
            token:
              this.mode === "local"
                ? descriptor.localToken
                : descriptor.bridgeToken,
          }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        try {
          parser.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (e) {
          socket.destroy(e as Error);
        }
      });
      socket.on("error", (e) => {
        if (!attached) reject(e);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (generation !== this.generation) return;
        if (!attached) reject(Error("Host connection closed"));
        this.status(false);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(Error("Host connection lost; outcome unknown"));
        }
        this.pending.clear();
        if (!this.stopped && !this.replaced && attached)
          this.scheduleReconnect();
      });
    });
  }
  private scheduleReconnect() {
    if (this.stopped || this.replaced) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => {
        void this.dial().catch(() => this.scheduleReconnect());
      },
      Math.min(5000, 200 * 2 ** Math.min(this.attempts++, 5)),
    );
  }
  async send(raw: unknown): Promise<void> {
    if (!this.ready || !this.socket || this.stopped)
      throw Error("Host is disconnected; outcome unknown");
    const command = Command.parse(raw);
    if (this.mode === "local") command.scope = this.scope;
    else if (!command.scope || !/^[A-Za-z0-9_-]{43}$/.test(command.scope))
      throw Error("Invalid device scope");
    const line = JSON.stringify(command) + "\n";
    if (
      Buffer.byteLength(line) > 1_048_576 ||
      this.socket.writableLength + Buffer.byteLength(line) > 1_048_576
    )
      throw Error("Host transport capacity exceeded");
    const socket = this.socket;
    await new Promise<void>((resolve, reject) =>
      socket.write(line, (e) => (e ? reject(e) : resolve())),
    );
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    _pi = false,
    options: { id?: string; scope?: string } = {},
  ): Promise<any> {
    if (!this.ready) return Promise.reject(Error("Host is disconnected"));
    const id = options.id ?? randomUUID(),
      scope = this.mode === "local" ? this.scope : options.scope;
    const key = scope + "\0" + id;
    const critical = [
      "hello",
      "session.current",
      "command.receipt",
      "cancel",
      "approval.respond",
      "client.detach",
    ].includes(method);
    if (this.pending.size >= (critical ? 128 : 112) || this.pending.has(key))
      return Promise.reject(
        Error("Host request capacity exceeded or duplicate ID"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Error("Host request timed out; outcome unknown"));
      }, 30000);
      this.pending.set(key, { resolve, reject, timer });
      void this.send({ id, scope, method, params }).catch((e) => {
        const p = this.pending.get(key);
        if (p) {
          this.pending.delete(key);
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retry);
    this.status(false);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("View closed; outcome unknown"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.observers.clear();
    this.listeners.clear();
    this.connections.clear();
  }
}
