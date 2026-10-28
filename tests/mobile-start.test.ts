import { it, expect, vi } from "vitest";
import {
  MobileController,
  pairingScope,
} from "../apps/mobile/src/controller.ts";
import { fixture } from "./helpers/mobile-controller.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";

function startup(existing = false, beforeList?: () => Promise<void>) {
  const old = { id: "old", title: "已有任务", cwd: "/workspace", createdAt: 1 };
  let sessions = existing ? [old] : [];
  let current: typeof old | null = existing ? old : null;
  const f = fixture({
    async request(frame) {
      switch (frame.method) {
        case "hello":
          return rpcCapabilities(true);
        case "session.current":
          return {
            session: current,
            sessionRole: current ? "control" : null,
            busy: false,
            stream: "",
            streamTruncated: false,
            cursor: 0,
            revision: 0,
            runId: null,
            runStatus: "idle",
            approvals: [],
          };
        case "session.list":
          await beforeList?.();
          return frame.params.offset ? [] : sessions;
        case "session.create": {
          current = {
            ...old,
            id: `new-${sessions.length + 1}`,
            title: "新任务",
          };
          sessions = [...sessions, current];
          return current;
        }
        case "session.resume":
          current =
            sessions.find((s) => s.id === frame.params.sessionId) ?? null;
          return current;
        case "messages.read":
          return { items: [], hasOlder: false, hasNewer: false };
        default:
          return { receipt: null };
      }
    },
    subscribe() {
      return () => {};
    },
  });
  return { f, old };
}
it("creates one empty session after first connection and exposes the composer without sending", async () => {
  const { f } = startup();
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.landing).toBe("task"));
    expect(app.state.session?.id).toBe("new-1");
    expect(app.state.canSend).toBe(true);
    expect(app.state.composer.record?.text).toBe("");
    await app.tasks();
    await app.tasks();
    f.close(1006);
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(f.sent.filter((c) => c.method === "session.create")).toHaveLength(1);
    expect(f.sent.some((c) => c.method === "prompt")).toBe(false);
  } finally {
    app.dispose();
  }
});
it("shows existing sessions and keeps an unsent draft without creating a new one", async () => {
  const { f, old } = startup(true);
  await f.store.write(JSON.stringify(f.pairing));
  await f.store.drafts.save(pairingScope(f.pairing), {
    session: old,
    text: "保留这段中文草稿",
  });
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.landing).toBe("tasks"));
    expect(app.state.sessions.map((s) => s.id)).toEqual(["old"]);
    expect(app.state.composer.record?.text).toBe("保留这段中文草稿");
    expect(
      f.sent.some(
        (c) => c.method === "session.create" || c.method === "prompt",
      ),
    ).toBe(false);
  } finally {
    app.dispose();
  }
});
it("explicit new session saves the previous draft and selects one new composer", async () => {
  const { f, old } = startup(true);
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.landing).toBe("tasks"));
    app.editDraft(old.id, "旧任务未发送");
    const [a, b] = await Promise.all([
      app.createSession(),
      app.createSession(),
    ]);
    expect(a.id).toBe(b.id);
    expect(f.sent.filter((c) => c.method === "session.create")).toHaveLength(1);
    expect(
      (await f.store.drafts.load(pairingScope(f.pairing), old.id))?.text,
    ).toBe("旧任务未发送");
    expect(app.state.session?.id).toBe(a.id);
    expect(app.state.composer.record?.text).toBe("");
  } finally {
    app.dispose();
  }
});

it("waits for history discovery before creating and never creates for an empty later page", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { f } = startup(true, () => gate);
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() =>
      expect(f.sent.some((c) => c.method === "session.list")).toBe(true),
    );
    expect(app.state.landing).toBeNull();
    expect(f.sent.some((c) => c.method === "session.create")).toBe(false);
    release();
    await vi.waitFor(() => expect(app.state.landing).toBe("tasks"));
    await app.tasks(50);
    expect(app.state.sessions).toEqual([]);
    expect(f.sent.some((c) => c.method === "session.create")).toBe(false);
  } finally {
    release();
    app.dispose();
  }
});

it("does not replay an automatic creation when its response is lost", async () => {
  const { f } = startup();
  await f.store.write(JSON.stringify(f.pairing));
  f.dropReply("session.create");
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() =>
      expect(app.state.sessions.map((s) => s.id)).toEqual(["new-1"]),
    );
    expect(f.sent.filter((c) => c.method === "session.create")).toHaveLength(1);
    expect(f.sent.some((c) => c.method === "prompt")).toBe(false);
  } finally {
    app.dispose();
  }
});
