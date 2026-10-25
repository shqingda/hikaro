import { ProcessClient } from "../../protocol/src/client.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentBackend,
  AgentEvent,
  ImageInput,
  Message,
} from "../../core/src/types.ts";

export interface PiTransport {
  request(
    method: string,
    params?: Record<string, unknown>,
    pi?: boolean,
  ): Promise<any>;
  send(message: unknown): Promise<void>;
  subscribe(listener: (message: any) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}
export type PiUIResponse =
  { value: string } | { confirmed: boolean } | { cancelled: true };
type Waiter = {
  resolve(): void;
  reject(error: unknown): void;
  accepted: boolean;
  settled?: { status: string; error?: string };
};

/** Pi owns the only loop, tools, approvals and authoritative session history. */
export class PiBackend implements AgentBackend {
  private listeners = new Set<(event: AgentEvent) => void>();
  private seq = 0;
  private waiters = new Set<Waiter>();
  private running = false;
  private closed = false;
  private cancellation?: Promise<void>;
  private lastError?: string;
  private sessionId = "external-pi";
  private dialogs = new Map<string, any>();
  private removeMessage: () => void;
  private removeExit: () => void;

  constructor(readonly client: PiTransport) {
    this.removeMessage = client.subscribe((message) => this.receive(message));
    this.removeExit = client.onExit((error) => {
      if (this.closed) return;
      this.closed = true;
      this.finish("failed", error.message);
      for (const waiter of this.waiters) waiter.reject(error);
      this.waiters.clear();
      this.emit("notice", { text: error.message });
      this.dismissDialogs();
    });
  }

  static async connect(
    command: string,
    cwd: string,
    options: {
      args?: string[];
      env?: NodeJS.ProcessEnv;
      onWarning?: (message: string) => void;
    } = {},
  ) {
    const { stdout } = await promisify(execFile)(command, ["--version"], {
      cwd,
      env: options.env,
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    const version = stdout.trim();
    if (!/^1\.4\.\d+$/.test(version))
      (options.onWarning ?? console.error)(
        `Pi ${version || "(unknown version)"} is unverified; Hikaro targets Pi 1.4.x. Checking its RPC contract before continuing.`,
      );
    const client = new ProcessClient(
      command,
      ["--mode", "rpc", ...(options.args ?? [])],
      {
        cwd,
        ...(options.env ? { env: options.env } : {}),
      },
    );
    const backend = new PiBackend(client);
    try {
      const state = await client.request("get_state", {}, true);
      if (
        !state ||
        typeof state.sessionId !== "string" ||
        !state.sessionId ||
        typeof state.isStreaming !== "boolean" ||
        typeof state.isCompacting !== "boolean" ||
        !Number.isSafeInteger(state.messageCount) ||
        state.messageCount < 0 ||
        !Number.isSafeInteger(state.pendingMessageCount) ||
        state.pendingMessageCount < 0
      )
        throw Error(
          "Pi get_state does not match the required RPC contract; no execution backend was changed",
        );
      backend.sessionId = state.sessionId;
      return backend;
    } catch (error) {
      await backend.close();
      throw error;
    }
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: string, data: Record<string, unknown>) {
    const event: AgentEvent = {
      sessionId: this.sessionId,
      seq: ++this.seq,
      type,
      data,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) listener(event);
  }

  private begin() {
    if (this.running) return;
    this.running = true;
    this.lastError = undefined;
    this.emit("run.start", {});
  }

  private completeWaiter(waiter: Waiter) {
    if (!waiter.accepted || !waiter.settled) return;
    this.waiters.delete(waiter);
    if (waiter.settled.status === "failed")
      waiter.reject(Error(waiter.settled.error ?? "Pi run failed"));
    else waiter.resolve();
  }

  private finish(status: string, error?: string) {
    const active = this.running;
    this.running = false;
    for (const waiter of this.waiters) {
      waiter.settled = { status, ...(error ? { error } : {}) };
      this.completeWaiter(waiter);
    }
    if (active) this.emit("run.end", { status, ...(error ? { error } : {}) });
  }

  private receive(message: any) {
    if (this.closed) return;
    switch (message.type) {
      case "agent_start":
        this.begin();
        break;
      case "message_start":
        if (message.message?.role === "assistant") this.lastError = undefined;
        break;
      case "message_update":
        if (message.assistantMessageEvent?.type === "text_delta")
          this.emit("text.delta", {
            text: message.assistantMessageEvent.delta,
          });
        break;
      case "message_end": {
        const source = message.message;
        if (!source) break;
        if (source.role === "assistant") {
          this.lastError =
            source.stopReason === "error"
              ? (source.errorMessage ?? "Pi model request failed")
              : undefined;
        }
        if (
          source.role !== "user" &&
          source.role !== "assistant" &&
          source.role !== "toolResult"
        )
          break;
        const text =
          typeof source.content === "string"
            ? source.content
            : (source.content ?? [])
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("");
        const converted: Message = {
          role: source.role === "toolResult" ? "tool" : source.role,
          text,
          timestamp: source.timestamp ?? Date.now(),
          ...(source.toolCallId
            ? {
                callId: source.toolCallId,
                name: source.toolName,
                isError: source.isError,
              }
            : {}),
        };
        this.emit("message", { message: converted });
        break;
      }
      case "tool_execution_start":
        this.emit("tool.start", {
          callId: message.toolCallId,
          name: message.toolName,
          arguments: message.args,
        });
        break;
      case "tool_execution_update":
        this.emit("tool.progress", {
          callId: message.toolCallId,
          name: message.toolName,
          result: message.partialResult,
        });
        break;
      case "tool_execution_end": {
        const text = (message.result?.content ?? [])
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join("\n");
        this.emit("tool.end", {
          callId: message.toolCallId,
          name: message.toolName,
          result: { text, data: message.result, isError: message.isError },
        });
        break;
      }
      // agent_end is only a low-level turn boundary; retries and queued work may follow.
      case "agent_settled":
        this.finish(
          message.aborted
            ? "cancelled"
            : this.lastError
              ? "failed"
              : "completed",
          this.lastError,
        );
        break;
      case "extension_ui_request":
        this.receiveUI(message);
        break;
      case "ui_prompt_end":
        this.dismissDialogs();
        break;
      case "extension_error":
        this.emit("notice", {
          text: `Pi extension: ${message.error ?? "Unknown error"}`,
        });
        break;
    }
  }

  private receiveUI(request: any) {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      this.dialogs.set(request.id, request);
      if (this.listeners.size) this.emit("ui.request", { ...request });
      else {
        // Startup extensions can ask before a terminal is attached. Never leave Pi blocked.
        void this.respondToUI(request.id, { cancelled: true }).catch(() => {});
      }
    } else if (request.method === "set_editor_text") {
      this.emit("ui.editor", { text: request.text ?? "" });
    } else if (request.method === "notify") {
      this.emit("notice", {
        text: request.message ?? "",
        level: request.notifyType,
      });
    } else if (request.method === "setStatus") {
      this.emit("ui.status", {
        key: request.statusKey,
        text: request.statusText,
      });
    } else if (
      request.method === "setWidget" &&
      Array.isArray(request.widgetLines)
    ) {
      this.emit("notice", { text: request.widgetLines.join("\n") });
    }
  }

  async respondToUI(id: string, response: PiUIResponse) {
    const request = this.dialogs.get(id);
    if (!request) return;
    if (
      "value" in response &&
      request.method === "select" &&
      !request.options.includes(response.value)
    )
      throw Error("Choose one of the Pi extension's listed options");
    await this.client.send({ type: "extension_ui_response", id, ...response });
    this.dialogs.delete(id);
    this.emit("ui.closed", { id });
  }

  private dismissDialogs() {
    for (const id of this.dialogs.keys()) this.emit("ui.closed", { id });
    this.dialogs.clear();
  }

  async prompt(text: string, images?: ImageInput[]) {
    if (this.closed) throw Error("Pi backend is closed");
    if (this.cancellation)
      throw Error("Pi is stopping; wait for cancellation to finish");
    if (!text.trim() && !images?.length) return;
    const wasRunning = this.running;
    this.begin();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, accepted: false };
      this.waiters.add(waiter);
      void this.client
        .request(
          "prompt",
          {
            message: text,
            ...(images?.length
              ? { images: images.map((image) => ({ type: "image", ...image })) }
              : {}),
            ...(wasRunning ? { streamingBehavior: "followUp" } : {}),
          },
          true,
        )
        .then(
          (result) => {
            if (!this.waiters.has(waiter)) return;
            if (result.disposition === "handled") {
              this.waiters.delete(waiter);
              resolve();
              if (!this.waiters.size && !wasRunning) this.finish("completed");
            } else {
              waiter.accepted = true;
              this.completeWaiter(waiter);
            }
          },
          (error) => {
            if (!this.waiters.delete(waiter)) return;
            reject(error);
            if (!this.waiters.size) this.finish("failed", String(error));
            else this.emit("notice", { text: String(error) });
          },
        );
    });
  }

  cancel() {
    if (this.closed || this.cancellation) return;
    this.cancellation = (async () => {
      try {
        // abort alone can continue queued prompts. Drain both queues first.
        await this.client.request("clear_queue", {}, true);
        for (const id of this.dialogs.keys())
          await this.respondToUI(id, { cancelled: true });
        await this.client.request("abort", {}, true);
        this.finish("cancelled");
      } catch (error) {
        this.finish("failed", String(error));
        for (const waiter of this.waiters) waiter.reject(error);
        this.waiters.clear();
      } finally {
        this.cancellation = undefined;
      }
    })();
  }

  steer(text: string) {
    if (this.closed || this.cancellation) return;
    void this.client
      .request("steer", { message: text }, true)
      .catch((error) => {
        this.emit("notice", { text: String(error) });
      });
  }

  async close() {
    if (this.closed) return this.client.close();
    this.closed = true;
    this.finish("cancelled");
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
    this.dismissDialogs();
    this.removeMessage();
    this.removeExit();
    await this.client.close();
  }
}
