import { it, expect } from "vitest";
import { SessionController } from "../packages/client-state/src/index.ts";
it("restores a snapshot, replays later events once, and clears resolved approvals", async () => {
  let listener: (m: any) => void = () => {};
  const session = { id: "s", cwd: "/workspace", title: "Task", createdAt: 0 };
  const rows = [
    { seq: 1, message: { role: "user", text: "hello", timestamp: 0 } },
  ];
  const transport = {
    subscribe(fn: (m: any) => void) {
      listener = fn;
      return () => {};
    },
    async request(method: string) {
      switch (method) {
        case "session.current":
          return {
            session,
            busy: true,
            cursor: 1,
            stream: "",
            approvals: [{ id: "a", sessionId: "s", reason: "test" }],
          };
        case "messages.read":
          return { items: rows, hasOlder: false, hasNewer: false };
        case "events.read":
          return [
            {
              sessionId: "s",
              seq: 2,
              type: "message",
              timestamp: 0,
              data: {
                message: { role: "assistant", text: "done", timestamp: 0 },
              },
            },
            {
              sessionId: "s",
              seq: 3,
              type: "run.end",
              timestamp: 0,
              data: { status: "completed" },
            },
          ];
        case "session.list":
          return [session];
        default:
          return {};
      }
    },
  };
  const controller = new SessionController(transport);
  try {
    await controller.recover();
    expect(controller.getSnapshot().rows).toHaveLength(2);
    expect(controller.getSnapshot().busy).toBe(false);
    listener({
      type: "event",
      event: {
        sessionId: "s",
        seq: 2,
        type: "message",
        data: { message: { role: "assistant", text: "duplicate" } },
      },
    });
    expect(controller.getSnapshot().rows).toHaveLength(2);
    listener({
      type: "approval",
      request: { id: "b", sessionId: "s", reason: "read" },
    });
    expect(controller.getSnapshot().approvals).toHaveLength(1);
    listener({ type: "approval.resolved", id: "b" });
    expect(controller.getSnapshot().approvals).toHaveLength(0);
  } finally {
    controller.dispose();
  }
});
