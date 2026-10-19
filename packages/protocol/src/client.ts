import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonLines } from "./index.ts";

/** One bounded JSONL channel. stdout is protocol-only; stderr is diagnostic text. */
export class ProcessClient {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(value: any) => void>();
  private observers = new Set<(value: unknown) => void>();
  private exits = new Set<(error: Error) => void>();
  private stderr = "";
  private ended?: Error;
  private closing?: Promise<void>;
  private closed: Promise<void>;

  constructor(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.child = spawn(command, args, { ...options, stdio: "pipe" });
    const parser = new JsonLines((value) => {
      const message = value as any;
      try {
        if (message.type === "response" && typeof message.id === "string") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error || message.success === false) {
            pending.reject(
              Error(
                typeof message.error === "string"
                  ? message.error
                  : JSON.stringify(message.error ?? "RPC request failed"),
              ),
            );
          } else pending.resolve(message.result ?? message.data ?? message);
        } else {
          for (const listener of this.listeners) listener(message);
        }
      } finally {
        for (const observer of this.observers) {
          try {
            observer(value);
          } catch {
            /* A state view must not break the transport. */
          }
        }
      }
    });
    this.child.stdout.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : Error(String(error)));
        this.child.kill();
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    // A disappearing subprocess can otherwise cause an unhandled EPIPE event.
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => {
      // close follows the final stdout/stderr data; exit can precede them.
      this.child.once("close", (code, signal) => {
        this.fail(
          Error(
            `Agent process exited (${signal ?? code})${this.stderr ? "\n" + this.stderr : ""}`,
          ),
        );
        resolve();
      });
    });
  }

  private fail(error: Error) {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.exits) listener(error);
  }

  /** All raw frames, in wire order, including responses; no duplicate request dispatch. */
  observe(observer: (value: unknown) => void) {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  subscribe(listener: (value: any) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onExit(listener: (error: Error) => void) {
    this.exits.add(listener);
    if (this.ended)
      queueMicrotask(() => {
        if (this.exits.has(listener)) listener(this.ended!);
      });
    return () => {
      this.exits.delete(listener);
    };
  }

  /** Send a notification, including Pi's extension_ui_response subprotocol. */
  send(message: unknown): Promise<void> {
    if (this.ended || this.closing)
      return Promise.reject(this.ended ?? Error("Agent process is closing"));
    let frame: string;
    try {
      frame = JSON.stringify(message) + "\n";
    } catch (error) {
      return Promise.reject(error);
    }
    const bytes = Buffer.byteLength(frame);
    if (bytes > 1_048_576)
      return Promise.reject(Error("Protocol frame too large"));
    if (this.child.stdin.writableLength + bytes > 1_048_576)
      return Promise.reject(Error("Agent transport is congested"));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(frame, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    pi = false,
    options: { id?: string; scope?: string } = {},
  ): Promise<any> {
    if (this.ended || this.closing)
      return Promise.reject(this.ended ?? Error("Agent process is closing"));
    const id = options.id ?? randomUUID();
    if (!id || id.length > 128)
      return Promise.reject(Error("Invalid RPC request id"));
    if (this.pending.has(id))
      return Promise.reject(Error("RPC request id is already pending"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`RPC timeout: ${method}`));
      }, 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const frame = pi
        ? { ...params, id, type: method }
        : {
            id,
            method,
            params,
            ...(options.scope ? { scope: options.scope } : {}),
          };
      void this.send(frame).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        pending.reject(error);
      });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        await this.closed;
        return;
      }
      this.child.stdin.end();
      const terminate = setTimeout(() => this.child.kill("SIGTERM"), 1500);
      const force = setTimeout(() => this.child.kill("SIGKILL"), 2500);
      terminate.unref();
      force.unref();
      try {
        await this.closed;
      } finally {
        clearTimeout(terminate);
        clearTimeout(force);
      }
    })();
    return this.closing;
  }
}
