import { describe, it, expect } from "vitest";
import { PiBridgeView } from "../packages/pi-bridge/src/view.ts";
import type { PiTransport } from "../packages/pi-bridge/src/index.ts";

class FakeHikaro implements PiTransport {
  calls: Array<{ method: string; params?: any }> = [];
  exits = new Set<(e: Error) => void>();
  handler: (method: string, params?: any) => Promise<any> = async (m) =>
    m === "session.create" || m === "session.resume"
      ? { id: "new-session" }
      : m === "messages.read"
        ? { items: [] }
        : {};
  listeners = new Set<(m: any) => void>();
  subscribe(f: (m: any) => void) {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }
  emit(m: any) {
    for (const f of this.listeners) f(m);
  }
  onExit(f: (e: Error) => void) {
    this.exits.add(f);
    return () => {
      this.exits.delete(f);
    };
  }
  request(method: string, params?: any) {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
  async send() {}
  async close() {}
  crash() {
    for (const f of this.exits) f(Error("Agent process exited (SIGKILL)"));
  }
}
const tui: any = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
const settle = () => new Promise((r) => setTimeout(r, 0));
const screen = (view: PiBridgeView) => view.render(80).join("\n");
const type = (view: PiBridgeView, text: string) => {
  for (const ch of text) view.handleInput(ch);
  view.handleInput("\r");
};

describe("Pi bridge view", () => {
  it("resumes the saved session and shows its recent messages", async () => {
    const client = new FakeHikaro();
    client.handler = async (m, p) =>
      m === "session.resume"
        ? { id: p.sessionId }
        : m === "messages.read"
          ? {
              items: [
                { seq: 1, message: { role: "user", text: "earlier question" } },
                {
                  seq: 2,
                  message: { role: "assistant", text: "earlier answer" },
                },
              ],
            }
          : {};
    const saved: string[] = [];
    const view = new PiBridgeView(tui, client, () => {}, {
      resumeSessionId: "s-1",
      onSession: (id) => saved.push(id),
    });
    await settle();
    await settle();
    expect(client.calls.map((c) => c.method)).toEqual([
      "session.resume",
      "messages.read",
    ]);
    expect(client.calls[0]?.params).toEqual({ sessionId: "s-1" });
    expect(screen(view)).toContain("You: earlier question");
    expect(screen(view)).toContain("earlier answer");
    expect(saved).toEqual(["s-1"]);
  });

  it("falls back to a new session when the saved one cannot be resumed", async () => {
    const client = new FakeHikaro();
    client.handler = async (m) => {
      if (m === "session.resume") throw Error("Session not found");
      return m === "session.create" ? { id: "fresh" } : {};
    };
    const saved: string[] = [];
    new PiBridgeView(tui, client, () => {}, {
      resumeSessionId: "gone",
      onSession: (id) => saved.push(id),
    });
    await settle();
    await settle();
    expect(client.calls.map((c) => c.method)).toEqual([
      "session.resume",
      "session.create",
    ]);
    expect(saved).toEqual(["fresh"]);
  });

  it("returns to Pi with /back or Ctrl+D after Hikaro disconnects, keeping the draft", async () => {
    for (const leave of ["/back", "\x04"]) {
      const client = new FakeHikaro();
      let done = 0;
      const view = new PiBridgeView(tui, client, () => done++);
      await settle();
      client.crash();
      type(view, "unsent draft");
      expect(screen(view)).toContain("not connected");
      expect(view.editor.getText()).toBe("unsent draft");
      if (leave === "/back") type(view, leave);
      else view.handleInput(leave);
      expect(done).toBe(1);
    }
  });

  it("shows a rejected prompt instead of staying busy", async () => {
    const client = new FakeHikaro();
    client.handler = async (m) =>
      m === "session.create" ? { id: "s" } : { accepted: true };
    const view = new PiBridgeView(tui, client, () => {});
    await settle();
    type(view, "hello");
    await settle();
    expect(screen(view)).toContain("Working");
    client.emit({
      type: "error",
      error: "Error: Session is running elsewhere",
    });
    expect(screen(view)).toContain("Session is running elsewhere");
    expect(screen(view)).not.toContain("Working");
  });
});
