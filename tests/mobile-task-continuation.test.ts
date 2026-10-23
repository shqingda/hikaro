import { expect, it, vi } from "vitest";
import {
  MobileController,
  pairingScope,
  type MobileOptions,
  type MobileSnapshot,
  type MobileStorage,
} from "../apps/mobile/src/controller.ts";
import type { DraftRecord } from "../apps/mobile/src/composer.ts";
import { canReturnToTask } from "../apps/mobile/src/task-continuation.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";
import type { RemoteSocket } from "../packages/remote/src/client.ts";

const session = {
  id: "saved-task",
  title: "上次任务",
  cwd: "/work",
  createdAt: 1,
};
const snapshot: MobileSnapshot = {
  session,
  items: [
    { seq: 1, message: { role: "assistant", text: "上次结果", timestamp: 1 } },
  ],
  savedAt: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  initialDraft: DraftRecord | null = { session, text: "未发送草稿" },
  initialSnapshot: MobileSnapshot | null = snapshot,
  probe: MobileOptions["probe"] = async () => "offline",
) {
  const pairing = {
    v: 1 as const,
    relay: "wss://fixture.example",
    hostId: randomToken(),
    hostKey: createIdentity().publicKey,
    deviceId: randomToken(),
    identity: createIdentity(),
    token: randomToken(),
    expires: Date.now() + 300000,
  };
  const scope = pairingScope(pairing);
  let credential: string | null = JSON.stringify(pairing);
  let draft = structuredClone(initialDraft);
  let cached = structuredClone(initialSnapshot);
  const send = vi.fn();
  const storage: MobileStorage = {
    read: async () => credential,
    write: async (value) => {
      credential = value;
    },
    erase: async () => {
      credential = null;
      draft = null;
      cached = null;
    },
    clear: async () => {
      draft = null;
      cached = null;
    },
    journal: () => ({ load: async () => [], save: async () => {} }),
    drafts: {
      load: vi.fn(async (key, id) =>
        key === scope && (!id || id === draft?.session.id)
          ? structuredClone(draft)
          : null,
      ),
      save: vi.fn(async (key, value) => {
        if (key === scope) draft = structuredClone(value);
      }),
    },
    snapshots: {
      load: async (key) => (key === scope ? structuredClone(cached) : null),
      save: async (key, value) => {
        if (key === scope) cached = structuredClone(value);
      },
      clear: async () => {
        cached = null;
      },
    },
  };
  const app = new MobileController(storage, {
    id: randomToken,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    probe,
    socketOptions: {
      reconnectMs: 60000,
      socket: () => {
        const socket: RemoteSocket = {
          readyState: 0,
          bufferedAmount: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send,
          close: () => {},
        };
        queueMicrotask(() =>
          socket.onclose?.call(
            socket as WebSocket,
            { code: 1006 } as CloseEvent,
          ),
        );
        return socket;
      },
    },
  });
  return { app, storage, scope, send };
}

it("returns to the restored offline task for reading and editing without selecting or sending", async () => {
  const { app, storage, scope, send } = fixture();
  try {
    await app.restore();
    expect(app.state.phase).toBe("offline");
    expect(app.state.messages).toEqual(snapshot.items);
    expect(canReturnToTask(app.state)).toBe(true);
    app.editDraft(session.id, "离线修改");
    await app.saveDraft();
    expect((await storage.drafts.load(scope, session.id))?.text).toBe(
      "离线修改",
    );
    await expect(app.select("another-task")).rejects.toThrow("Not connected");
    await expect(app.sendDraft(session.id)).rejects.toThrow("offline");
    expect(app.state.canSend).toBe(false);
    expect(app.state.canSteer).toBe(false);
    expect(send).not.toHaveBeenCalled();
  } finally {
    app.dispose();
  }
});

it("returns to snapshot-only history after the controller loads its matching empty draft", async () => {
  const { app } = fixture(null);
  try {
    await app.restore();
    expect(app.state.composer.record).toEqual({ session, text: "" });
    expect(canReturnToTask(app.state)).toBe(true);
    await app.clearHistoryCache();
    expect(app.state.messages).toEqual([]);
    expect(canReturnToTask(app.state)).toBe(true);
  } finally {
    app.dispose();
  }
});

it("keeps the current draft reachable after a failed connection and rejects another task's snapshot", async () => {
  const { app } = fixture(
    undefined,
    { ...snapshot, session: { ...session, id: "other" } },
    async () => {
      throw Error("network unavailable");
    },
  );
  try {
    await app.restore();
    expect(app.state.phase).toBe("error");
    expect(app.state.session?.id).toBe(session.id);
    expect(app.state.messages).toEqual([]);
    expect(canReturnToTask(app.state)).toBe(true);
  } finally {
    app.dispose();
  }
});

it("allows the loaded current task during reconnect but closes access on background and removal", async () => {
  const probe = deferred<"offline">();
  const { app } = fixture(undefined, undefined, () => probe.promise);
  try {
    const restoring = app.restore();
    expect(canReturnToTask(app.state)).toBe(false);
    await vi.waitFor(() => expect(app.state.messages).toEqual(snapshot.items));
    expect(app.state.phase).toBe("connecting");
    expect(canReturnToTask(app.state)).toBe(true);
    app.suspend();
    expect(canReturnToTask(app.state)).toBe(false);
    probe.resolve("offline");
    await restoring;
    expect(canReturnToTask(app.state)).toBe(false);
    await app.restore();
    expect(canReturnToTask(app.state)).toBe(true);
    await app.forget();
    expect(canReturnToTask(app.state)).toBe(false);
  } finally {
    probe.resolve("offline");
    app.dispose();
  }
});

it("does not expose a missing, loading or mismatched draft, or a locked connection", async () => {
  const { app } = fixture();
  try {
    await app.restore();
    const state = app.state;
    expect(
      canReturnToTask({
        ...state,
        composer: { ...state.composer, loading: true },
      }),
    ).toBe(false);
    expect(
      canReturnToTask({
        ...state,
        composer: { ...state.composer, record: null },
      }),
    ).toBe(false);
    expect(
      canReturnToTask({ ...state, session: { ...session, id: "other" } }),
    ).toBe(false);
    for (const phase of [
      "unpaired",
      "review",
      "restoring",
      "background",
      "revoked",
      "blocked",
    ] as const)
      expect(canReturnToTask({ ...state, phase })).toBe(false);
    expect(
      canReturnToTask({
        ...state,
        phase: "connected",
        composer: { ...state.composer, loading: true },
      }),
    ).toBe(true);
  } finally {
    app.dispose();
  }
});

it("does not use the previous in-memory draft while a restore is loading or after it finds no local task", async () => {
  const { app, storage, scope } = fixture();
  const loading = deferred<DraftRecord | null>();
  try {
    await app.restore();
    expect(canReturnToTask(app.state)).toBe(true);
    const readDraft = vi
      .spyOn(storage.drafts, "load")
      .mockReturnValueOnce(loading.promise);
    const restoring = app.restore();
    await vi.waitFor(() => expect(app.state.composer.loading).toBe(true));
    expect(app.state.composer.record?.session.id).toBe(session.id);
    expect(app.state.session).toBeNull();
    expect(canReturnToTask(app.state)).toBe(false);
    loading.resolve(null);
    await restoring;
    expect(canReturnToTask(app.state)).toBe(true);
    readDraft.mockRestore();
    await storage.clear(scope);
    await app.restore();
    expect(app.state.session).toBeNull();
    expect(canReturnToTask(app.state)).toBe(false);
  } finally {
    loading.resolve(null);
    app.dispose();
  }
});
