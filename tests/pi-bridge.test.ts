import { describe, it, expect } from "vitest";
import {
  PiBackend,
  type PiTransport,
} from "../packages/pi-bridge/src/index.ts";
class FakePi implements PiTransport {
  listeners = new Set<(m: any) => void>();
  calls: string[] = [];
  sent: any[] = [];
  handler: (method: string) => Promise<any> = async () => ({});
  subscribe(f: (m: any) => void) {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }
  onExit() {
    return () => {};
  }
  request(method: string, _params?: Record<string, unknown>, _pi?: boolean) {
    this.calls.push(method);
    return this.handler(method);
  }
  async send(m: unknown) {
    this.sent.push(m);
  }
  async close() {}
  emit(m: any) {
    for (const f of this.listeners) f(m);
  }
}
describe("Pi RPC contract", () => {
  it("lists and switches models through Pi's public RPC and refuses switching while busy", async () => {
    const transport = new FakePi();
    const model = {
      provider: "pi-provider",
      id: "pi-model",
      name: "Pi model",
      contextWindow: 128000,
      maxTokens: 8000,
      input: ["text"],
      reasoning: false,
    };
    const requests: Array<{
      method: string;
      params?: Record<string, unknown>;
      pi?: boolean;
    }> = [];
    transport.request = async (method, params, pi) => {
      requests.push({ method, params, pi });
      if (method === "get_available_models") return { models: [model] };
      if (method === "set_model") return model;
      return {};
    };
    const backend = new PiBackend(transport);
    expect(await backend.availableModels()).toMatchObject([
      { provider: "pi-provider", id: "pi-model", name: "Pi model" },
    ]);
    await backend.setModel("pi-provider", "pi-model");
    expect(requests.at(-1)).toEqual({
      method: "set_model",
      params: { provider: "pi-provider", modelId: "pi-model" },
      pi: true,
    });
    expect(backend.currentModel).toMatchObject({
      provider: "pi-provider",
      id: "pi-model",
    });
    transport.emit({ type: "agent_start" });
    await expect(backend.setModel("pi-provider", "pi-model")).rejects.toThrow(
      "running",
    );
    await backend.close();
  });
  it("waits for agent_settled, not agent_end", async () => {
    const transport = new FakePi(),
      backend = new PiBackend(transport);
    let done = false;
    const prompt = backend.prompt("test").then(() => {
      done = true;
    });
    await Promise.resolve();
    transport.emit({ type: "agent_end" });
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emit({ type: "agent_settled" });
    await prompt;
    expect(done).toBe(true);
    await backend.close();
  });
  it("resolves handled prompts without waiting for a nonexistent agent run", async () => {
    const transport = new FakePi();
    transport.handler = async () => ({ disposition: "handled" });
    const backend = new PiBackend(transport);
    await backend.prompt("/command");
    await backend.close();
  });
  it("clears queued prompts before aborting", async () => {
    const transport = new FakePi(),
      backend = new PiBackend(transport);
    const prompt = backend.prompt("test");
    await Promise.resolve();
    backend.cancel();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await prompt;
    expect(transport.calls.slice(-2)).toEqual(["clear_queue", "abort"]);
    await backend.close();
  });
  it("responds to Pi extension confirmation requests", async () => {
    const transport = new FakePi(),
      backend = new PiBackend(transport);
    const events: any[] = [];
    backend.subscribe((e) => events.push(e));
    transport.emit({
      type: "extension_ui_request",
      id: "approval",
      method: "confirm",
      message: "Allow?",
    });
    expect(events.at(-1)?.type).toBe("ui.request");
    await backend.respondToUI("approval", { confirmed: false });
    expect(transport.sent[0]).toEqual({
      type: "extension_ui_response",
      id: "approval",
      confirmed: false,
    });
    await backend.close();
  });
});
