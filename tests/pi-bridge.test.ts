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
  request(method: string) {
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
