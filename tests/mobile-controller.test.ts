import { randomUUID } from "node:crypto";
import { it, expect, vi } from "vitest";
import { mobileLifecycle } from "../apps/mobile/src/lifecycle.ts";
import {
  MobileController,
  pairingScope,
} from "../apps/mobile/src/controller.ts";
import type { DraftRecord, DraftStore } from "../apps/mobile/src/composer.ts";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
const clock = {
  id: randomToken,
  schedule: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
function fixture(
  hooks?: {
    request(frame: any): Promise<unknown>;
    subscribe(fn: (frame: any) => void): () => void;
  },
  content?: (params: any) => Promise<unknown>,
  snapshotPatch: Record<string, unknown> = {},
  capabilities = rpcCapabilities(true),
) {
  const host = createIdentity(),
    device = createIdentity();
  const pairing = {
    v: 1 as const,
    relay: "wss://fixture.example",
    hostId: randomToken(),
    deviceId: randomToken(),
    token: randomToken(),
    identity: device,
    hostKey: host.publicKey,
    expires: Date.now() + 300000,
  };
  let credential: string | null = null,
    active: any,
    dropMethod = "";
  let nextList: (() => Promise<unknown>) | undefined;
  let messageItems: unknown[] | undefined;
  let planRead: ((params: any) => Promise<unknown>) | undefined;
  const readList = () => {
    const read = nextList;
    nextList = undefined;
    return read ? read() : [session];
  };
  const intents: any[] = [];
  const draftRows = new Map<string, DraftRecord>();
  const snapshots = new Map<string, unknown>();
  const drafts: DraftStore = {
    load: vi.fn(async (scope, id) =>
      structuredClone(
        id
          ? (draftRows.get(scope + id) ?? null)
          : ([...draftRows.entries()]
              .filter(([key]) => key.startsWith(scope))
              .at(-1)?.[1] ?? null),
      ),
    ),
    save: vi.fn(async (scope, record) => {
      draftRows.set(scope + record.session.id, structuredClone(record));
    }),
  };
  const sent: any[] = [];
  const session = {
    id: "s1",
    title: "共享任务",
    cwd: "/workspace",
    createdAt: 1,
  };
  let selected: any = session,
    revision = 0;
  const store = {
    drafts,
    snapshots: {
      load: vi.fn(async (scope: string) =>
        structuredClone(snapshots.get(scope) ?? null),
      ),
      save: vi.fn(async (scope: string, value: unknown) => {
        snapshots.set(scope, structuredClone(value));
      }),
      clear: vi.fn(async (scope: string) => {
        snapshots.delete(scope);
      }),
    },
    read: vi.fn(async () => credential),
    write: vi.fn(async (value: string) => {
      credential = value;
    }),
    erase: vi.fn(async () => {
      credential = null;
      draftRows.clear();
      snapshots.clear();
    }),
    journal: () => ({
      load: async () => intents.slice(),
      save: async (value: any[]) => {
        intents.splice(0, intents.length, ...value);
      },
    }),
    clear: vi.fn(async () => {
      intents.length = 0;
      draftRows.clear();
      snapshots.clear();
    }),
  };
  const socket = () => {
    const channel = new SecureChannel("host", host, device.publicKey);
    let release = () => {};
    const ws: any = {
      readyState: 1,
      bufferedAmount: 0,
      send(text: string) {
        if (text === "ping") return;
        const result = channel.receive(text);
        if (result.reply)
          queueMicrotask(() => ws.onmessage?.({ data: result.reply }));
        if (result.data) {
          const frame = result.data as any;
          sent.push(frame);
          const rpcResult =
            frame.method === "messages.content" && content
              ? content(frame.params)
              : frame.method === "plan.read" && planRead
                ? planRead(frame.params)
                : hooks
                  ? hooks.request(frame)
                  : frame.method === "hello"
                    ? capabilities
                    : frame.method === "session.current"
                      ? {
                          session: selected,
                          sessionRole: "view",
                          busy: false,
                          stream: "",
                          streamTruncated: false,
                          cursor: 2,
                          revision,
                          runId: "run1",
                          runStatus: "completed",
                          approvals: [],
                          ...snapshotPatch,
                        }
                      : frame.method === "session.list"
                        ? readList()
                        : frame.method === "messages.read"
                          ? {
                              items: messageItems ?? [
                                {
                                  seq: 2,
                                  message: {
                                    role: "assistant",
                                    text: "已恢复的结果",
                                    timestamp: 1,
                                  },
                                },
                              ],
                              hasOlder: false,
                              hasNewer: false,
                            }
                          : frame.method === "session.resume"
                            ? (selected = session)
                            : frame.method === "run.cancel"
                              ? { accepted: true, runId: frame.params.runId }
                              : frame.method === "push.register"
                                ? { ok: true }
                                : { receipt: null };
          void Promise.resolve(rpcResult).then(
            (result) => {
              if (dropMethod === frame.method) {
                dropMethod = "";
                ws.close(1006);
                return;
              }
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    result,
                  }),
                });
            },
            (error) => {
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    error: String(error),
                  }),
                });
            },
          );
        }
      },
      close(code: number) {
        if (ws.readyState !== 1) return;
        ws.readyState = 3;
        release();
        ws.onclose?.({ code });
      },
    };
    if (hooks)
      release = hooks.subscribe((frame) => {
        if (frame.scope === pairing.deviceId && ws.readyState === 1)
          ws.onmessage?.({ data: channel.send(frame) });
      });
    active = ws;
    queueMicrotask(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: channel.hello() });
    });
    return ws;
  };
  return {
    pairing,
    host,
    store,
    sent,
    options: {
      ...clock,
      probe: async () => "ready" as const,
      socketOptions: { socket, reconnectMs: 1, heartbeatMs: 60000 },
    },
    delayNextList: (read: () => Promise<unknown>) => {
      nextList = read;
    },
    setMessages: (items: unknown[]) => {
      messageItems = items;
    },
    setPlanRead: (read: (params: any) => Promise<unknown>) => {
      planRead = read;
    },
    uri: () => "hikaro://pair#" + encodeURIComponent(JSON.stringify(pairing)),
    dropResume: () => {
      dropMethod = "session.resume";
    },
    dropReply: (method: string) => {
      dropMethod = method;
    },
    close: (code: number) => active.close(code),
    get credential() {
      return credential;
    },
  };
}
it("registers and clears push over the encrypted transport and rejects stale pairing identity", async () => {
  const f = fixture(
    undefined,
    undefined,
    {},
    {
      ...rpcCapabilities(true),
      methods: [...rpcCapabilities(true).methods, "push.register"],
    },
  );
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.configurePush("ExpoPushToken[test]");
    await app.configurePush(null);
    await expect(
      app.configurePush("ExpoPushToken[test]", "old-pairing"),
    ).rejects.toThrow("连接已变化");
    expect(
      f.sent
        .filter((frame) => frame.method === "push.register")
        .map((frame) => frame.params),
    ).toEqual([{ token: "ExpoPushToken[test]" }, { token: null }]);
  } finally {
    app.dispose();
  }
});
it("reopens cached task messages offline without sending and clears cache without losing drafts", async () => {
  const f = fixture();
  const scope = pairingScope(f.pairing);
  const session = {
    id: "s1",
    title: "共享任务",
    cwd: "/workspace",
    createdAt: 1,
  };
  const items = [
    {
      seq: 2,
      message: { role: "assistant", text: "上次结果\n第二行", timestamp: 1 },
    },
  ];
  await f.store.write(JSON.stringify(f.pairing));
  await f.store.snapshots.save(scope, { session, items, savedAt: 1 });
  await f.store.drafts.save(scope, { session, text: "未发送草稿" });
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => {
      throw Error("offline");
    },
  });
  try {
    await app.restore();
    expect(app.state.messages).toEqual(items);
    expect(app.state.canSend).toBe(false);
    expect(app.state.canSteer).toBe(false);
    expect(f.sent).toEqual([]);
    await app.clearHistoryCache();
    expect(app.state.cacheClear).toBe("cleared");
    expect(await f.store.snapshots.load(scope)).toBeNull();
    expect(app.state.messages).toEqual([]);
    expect(app.state.composer.record?.text).toBe("未发送草稿");
    await app.forget();
    expect(await f.store.drafts.load(scope, session.id)).toBeNull();
  } finally {
    app.dispose();
  }
});

it("removes a failed cache-clear notice after a successful offline retry", async () => {
  const f = fixture();
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => {
      throw Error("offline");
    },
  });
  try {
    await app.restore();
    const connectionError = app.state.error;
    f.store.snapshots.clear.mockRejectedValueOnce(Error("storage unavailable"));
    await expect(app.clearHistoryCache()).rejects.toThrow(
      "storage unavailable",
    );
    expect(app.state.cacheClear).toBe("failed");
    expect(app.state.error).toBe(connectionError);
    await app.clearHistoryCache();
    expect(app.state.cacheClear).toBe("cleared");
    expect(app.state.error).toBe(connectionError);
  } finally {
    app.dispose();
  }
});

it("clears an online snapshot once while preserving messages and allowing later reads to cache again", async () => {
  const f = fixture();
  const scope = pairingScope(f.pairing);
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clear = f.store.snapshots.clear.getMockImplementation()!;
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.history();
    const messages = app.state.messages;
    expect(messages).not.toEqual([]);
    f.store.snapshots.clear.mockImplementationOnce(async (value) => {
      await gate;
      await clear(value);
    });
    const clearing = app.clearHistoryCache();
    expect(app.state.cacheClear).toBe("clearing");
    await app.clearHistoryCache();
    expect(f.store.snapshots.clear).toHaveBeenCalledTimes(1);
    expect(await f.store.snapshots.load(scope)).not.toBeNull();
    release();
    await clearing;
    expect(app.state.cacheClear).toBe("cleared");
    expect(await f.store.snapshots.load(scope)).toBeNull();
    expect(app.state.messages).toEqual(messages);
    await app.history();
    expect(await f.store.snapshots.load(scope)).not.toBeNull();
    expect(app.state.cacheClear).toBe("cleared");
  } finally {
    release();
    app.dispose();
  }
});

it("does not run an old queued cache clear after reconnecting the same pairing", async () => {
  const f = fixture();
  const scope = pairingScope(f.pairing);
  const snapshot = {
    session: { id: "s1", title: "任务", cwd: "/workspace", createdAt: 1 },
    items: [
      { seq: 2, message: { role: "assistant", text: "缓存", timestamp: 1 } },
    ],
    savedAt: 1,
  };
  await f.store.write(JSON.stringify(f.pairing));
  await f.store.snapshots.save(scope, snapshot);
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => {
      throw Error("offline");
    },
  });
  try {
    await app.restore();
    const clearing = app.clearHistoryCache();
    const restoring = app.restore();
    await Promise.all([clearing, restoring]);
    expect(f.store.snapshots.clear).not.toHaveBeenCalled();
    expect(await f.store.snapshots.load(scope)).toEqual(snapshot);
    expect(app.state.messages).toEqual(snapshot.items);
    expect(app.state.cacheClear).toBe("idle");
  } finally {
    app.dispose();
  }
});

it.each(["success", "failure"])(
  "ignores a cache-clear %s after the pairing is removed and replaced",
  async (outcome) => {
    const f = fixture();
    await f.store.write(JSON.stringify(f.pairing));
    const app = new MobileController(f.store, {
      ...f.options,
      probe: async () => {
        throw Error("offline");
      },
    });
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await app.restore();
      f.store.snapshots.clear.mockImplementationOnce(async () => {
        began();
        await gate;
        if (outcome === "failure") throw Error("old clear failed");
      });
      const clearing = app.clearHistoryCache().catch(() => {});
      await started;
      const statuses: string[] = [];
      const unsubscribe = app.subscribe(() => {
        statuses.push(app.state.cacheClear);
      });
      const removing = app.forget();
      expect(app.state.cacheClear).toBe("idle");
      release();
      await Promise.all([clearing, removing]);
      unsubscribe();
      expect(statuses).not.toContain("cleared");
      expect(statuses).not.toContain("failed");
      expect(app.state.phase).toBe("unpaired");
      expect(app.state.cacheClear).toBe("idle");
      const replacement = fixture();
      app.review(replacement.uri());
      await app.confirm().catch(() => {});
      expect(app.state.deviceId).toBe(replacement.pairing.deviceId);
      expect(app.state.cacheClear).toBe("idle");
      await app.clearHistoryCache();
      expect(app.state.cacheClear).toBe("cleared");
      expect(f.store.snapshots.clear).toHaveBeenLastCalledWith(
        pairingScope(replacement.pairing),
      );
    } finally {
      release();
      app.dispose();
    }
  },
);

it.each(["other-device", "other-task", "oversized"])(
  "does not restore an invalid or unrelated offline snapshot (%s)",
  async (scenario) => {
    const f = fixture();
    const scope = pairingScope(f.pairing);
    const session = {
      id: "s1",
      title: "任务",
      cwd: "/workspace",
      createdAt: 1,
    };
    await f.store.write(JSON.stringify(f.pairing));
    await f.store.drafts.save(scope, { session, text: "草稿" });
    await f.store.snapshots.save(
      scenario === "other-device" ? "another-identity" : scope,
      {
        session: { ...session, id: scenario === "other-task" ? "s2" : "s1" },
        items: [
          {
            seq: 2,
            message: {
              role: "assistant",
              timestamp: 1,
              text: scenario === "oversized" ? "x".repeat(20001) : "另一份内容",
            },
          },
        ],
        savedAt: 1,
      },
    );
    const app = new MobileController(f.store, {
      ...f.options,
      probe: async () => {
        throw Error("offline");
      },
    });
    try {
      await app.restore();
      expect(app.state.messages).toEqual([]);
      expect(app.state.session?.id).toBe("s1");
      expect(app.state.composer.record?.text).toBe("草稿");
      expect(f.sent).toEqual([]);
    } finally {
      app.dispose();
    }
  },
);

it("serializes cache deletion after an in-flight save when forgetting the device", async () => {
  const f = fixture();
  const scope = pairingScope(f.pairing);
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(async () =>
      expect(await f.store.snapshots.load(scope)).not.toBeNull(),
    );
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = f.store.snapshots.save.getMockImplementation()!;
    f.store.snapshots.save.mockImplementationOnce(async (scope, snapshot) => {
      started();
      await gate;
      await save(scope, snapshot);
    });
    const reading = app.history("latest");
    await began;
    const forgetting = app.forget();
    release();
    await Promise.all([reading, forgetting]);
    expect(await f.store.snapshots.load(scope)).toBeNull();
    expect(app.state.messages).toEqual([]);
    expect(app.state.phase).toBe("unpaired");
  } finally {
    app.dispose();
  }
});

it("restores an offline composer without authority or auto-send and erases drafts after pending saves", async () => {
  const f = fixture();
  const session = {
    id: "s1",
    title: "上次任务",
    cwd: "/workspace",
    createdAt: 1,
  };
  await f.store.write(JSON.stringify(f.pairing));
  await f.store.drafts.save(pairingScope(f.pairing), {
    session,
    text: "离线草稿",
  });
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => {
      throw Error("offline");
    },
  });
  try {
    await app.restore();
    expect(app.state.session?.id).toBe(session.id);
    expect(app.state.composer.record?.text).toBe("离线草稿");
    expect(app.state.canSend).toBe(false);
    await expect(app.sendDraft(session.id)).rejects.toThrow(/control/);
    const edits: string[] = [];
    const unsubscribe = app.subscribe(() => {
      edits.push(app.state.composer.record?.text ?? "");
    });
    const sentBeforeEditing = f.sent.length;
    try {
      for (const text of ["离线编辑", "离线编辑\n", "离线编辑\n第二行"]) {
        app.editDraft(session.id, text);
        // Controlled native inputs need the new value synchronously, not on a later paint.
        expect(edits.at(-1)).toBe(text);
      }
      expect(f.sent).toHaveLength(sentBeforeEditing);
    } finally {
      unsubscribe();
    }
    await app.saveDraft();
    app.suspend();
    expect(app.state.composer.record).toBeNull();
    await app.restore();
    expect(app.state.composer.record?.text).toBe("离线编辑\n第二行");
    const save = f.store.drafts.save;
    let release!: () => void;
    vi.mocked(save).mockImplementationOnce(
      (scope, record) =>
        new Promise<void>((resolve) => {
          release = () => {
            void save(scope, record).then(resolve);
          };
        }),
    );
    app.editDraft(session.id, "正在保存");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const forget = app.forget();
    release();
    await forget;
    expect(app.state.phase).toBe("unpaired");
    expect(await f.store.drafts.load(pairingScope(f.pairing))).toBeNull();
    expect(f.sent.filter((f) => f.method === "prompt")).toHaveLength(0);
  } finally {
    app.dispose();
  }
});

it("requires current control authority for approvals and never sends expired or repeated decisions", async () => {
  const approval = {
    id: "approval1",
    sessionId: "s1",
    tool: "shell",
    reason: "Run a command",
    arguments: { command: "echo hello" },
  };
  const snapshot = { sessionRole: "view", approvals: [approval] };
  const f = fixture(undefined, undefined, snapshot);
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await expect(app.respondApproval(approval.id, true)).rejects.toThrow(
      /control/i,
    );
    expect(app.state.actionNotice).toContain("控制权限");
    expect(f.sent.filter((f) => f.method === "approval.respond")).toHaveLength(
      0,
    );
    snapshot.sessionRole = "control";
    await app.restore();
    await vi.waitFor(() => expect(app.state.sessionRole).toBe("control"));
    await expect(app.respondApproval("expired", true)).rejects.toThrow(
      /expired/i,
    );
    expect(app.state.actionNotice).toContain("已失效");
    const response = app.respondApproval(approval.id, false);
    await expect(app.respondApproval(approval.id, true)).rejects.toThrow(
      /pending/i,
    );
    await response;
    expect(app.state.actionNotice).toContain("电脑已收到决定");
    expect(f.sent.filter((f) => f.method === "approval.respond")).toMatchObject(
      [{ params: { id: approval.id, allow: false, sessionId: "s1" } }],
    );
    app.suspend();
    expect(app.state.approvals).toEqual([]);
    await expect(app.respondApproval(approval.id, true)).rejects.toThrow();
    await expect(app.reconcileActions()).rejects.toThrow(/connected/i);
    expect(app.state.actionNotice).toContain("恢复连接");
  } finally {
    app.dispose();
  }
});
it("stops only the confirmed current run and never falls back to legacy cancellation", async () => {
  const snapshot = {
    sessionRole: "control",
    runId: "run-2",
    runStatus: "running",
    busy: true,
  };
  const f = fixture(undefined, undefined, snapshot);
  const app = new MobileController(f.store, f.options);
  const old = fixture(undefined, undefined, snapshot, {
    ...rpcCapabilities(true),
    methods: rpcCapabilities(true).methods.filter(
      (method) => method !== "run.cancel",
    ),
  });
  const legacy = new MobileController(old.store, old.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(app.state.canStopRun).toBe(true);
    await expect(app.stopRun("s1", "run-1")).rejects.toThrow(/expired/i);
    await expect(app.stopRun("other", "run-2")).rejects.toThrow(/expired/i);
    expect(f.sent.some((frame) => frame.method === "run.cancel")).toBe(false);
    const stopping = app.stopRun("s1", "run-2");
    await expect(app.stopRun("s1", "run-2")).rejects.toThrow(/pending/i);
    await stopping;
    expect(app.state.runStatus).toBe("running"); // A receipt cannot invent a terminal event.
    expect(
      f.sent.filter((frame) => frame.method === "run.cancel"),
    ).toMatchObject([{ params: { sessionId: "s1", runId: "run-2" } }]);
    legacy.review(old.uri());
    await legacy.confirm();
    await vi.waitFor(() => expect(legacy.state.phase).toBe("connected"));
    expect(legacy.state.canStopRun).toBe(false);
    await expect(legacy.stopRun("s1", "run-2")).rejects.toThrow(/support/i);
    expect(
      old.sent.some((frame) => ["run.cancel", "cancel"].includes(frame.method)),
    ).toBe(false);
    expect(legacy.state.actionNotice).toContain("更新电脑");
  } finally {
    app.dispose();
    legacy.dispose();
  }
});

it("keeps bounded tool identity and failures in history without caching call arguments", async () => {
  const f = fixture();
  f.setMessages([
    {
      seq: 2,
      message: {
        role: "assistant",
        text: "",
        timestamp: 1,
        toolCalls: [
          { id: "call-1", name: "shell", arguments: { command: "private" } },
        ],
      },
    },
    {
      seq: 3,
      message: {
        role: "tool",
        name: "shell",
        isError: true,
        text: "命令未成功",
        timestamp: 2,
      },
    },
  ]);
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.history();
    expect(app.state.messages[0]?.message).toMatchObject({
      text: "",
      toolCalls: [{ id: "call-1", name: "shell" }],
    });
    expect(app.state.messages[0]?.message).not.toHaveProperty(
      "toolCalls.0.arguments",
    );
    expect(app.state.messages[1]?.message).toMatchObject({
      name: "shell",
      isError: true,
    });
    const cached = await f.store.snapshots.load(pairingScope(f.pairing));
    expect(cached).toMatchObject({
      items: [
        { message: { toolCalls: [{ id: "call-1", name: "shell" }] } },
        { message: { name: "shell", isError: true } },
      ],
    });
    expect(JSON.stringify(cached)).not.toContain("private");
  } finally {
    app.dispose();
  }
});

it("reads complete tool calls in bounded Unicode-safe pages and can return to ordinary text", async () => {
  const calls = JSON.stringify([
    {
      id: "call-1",
      name: "shell",
      arguments: { command: "中文🌅".repeat(7000) },
    },
  ]);
  const f = fixture(undefined, async (params) => {
    const text = params.field === "toolCalls" ? calls : "普通正文";
    const end = Math.min(text.length, params.offset + params.limit);
    return {
      data: text.slice(params.offset, end),
      total: text.length,
      nextOffset: end < text.length ? end : null,
      encoding: "utf16",
    };
  });
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    const chunks: string[] = [];
    for (let offset = 0; ;) {
      await app.readMessage(2, offset, "toolCalls");
      expect(app.state.content).toMatchObject({ field: "toolCalls", offset });
      const page = app.state.content!.page!;
      chunks.push(page.data);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join("")).toBe(calls);
    expect(
      f.sent
        .filter((frame) => frame.method === "messages.content")
        .every(
          (frame) =>
            frame.params.field === "toolCalls" && frame.params.limit === 8192,
        ),
    ).toBe(true);
    await app.readMessage(2);
    expect(app.state.content).toMatchObject({
      field: "text",
      page: { data: "普通正文" },
    });
    const requestCount = f.sent.length;
    for (const field of ["thinking", "image", "artifact"])
      await expect(app.readMessage(2, 0, field as "text")).rejects.toThrow();
    expect(f.sent).toHaveLength(requestCount);
    expect(
      f.sent.some((frame) =>
        ["prompt", "steer", "tool.manual"].includes(frame.method),
      ),
    ).toBe(false);
  } finally {
    app.dispose();
  }
});

it("does not replace a newer tool-call page with an older ordinary-text response", async () => {
  let finish!: (page: unknown) => void;
  const toolPage = {
    data: "[]",
    total: 2,
    nextOffset: null,
    encoding: "utf16",
  };
  const f = fixture(undefined, (params) =>
    params.field === "text"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(toolPage),
  );
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    const earlier = app.readMessage(2);
    void earlier.catch(() => {});
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await app.readMessage(2, 0, "toolCalls");
    finish({ data: "old", total: 3, nextOffset: null, encoding: "utf16" });
    await earlier;
    expect(app.state.content).toMatchObject({
      field: "toolCalls",
      page: { data: "[]" },
    });
  } finally {
    app.dispose();
  }
});

it.each(["close", "selection", "background"] as const)(
  "fences a late tool-call page after %s",
  async (invalidate) => {
    let finish!: (page: unknown) => void;
    const f = fixture(
      undefined,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const app = new MobileController(f.store, f.options);
    try {
      app.review(f.uri());
      await app.confirm();
      await vi.waitFor(() =>
        expect(app.state.composer.record?.session.id).toBe("s1"),
      );
      const pending = app.readMessage(2, 0, "toolCalls");
      void pending.catch(() => {});
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(
        f.sent.filter((frame) => frame.method === "messages.content").at(-1)
          ?.params.field,
      ).toBe("toolCalls");
      if (invalidate === "close") app.closeMessage();
      if (invalidate === "selection") await app.select("s1");
      if (invalidate === "background") app.suspend();
      finish({ data: "[]", total: 2, nextOffset: null, encoding: "utf16" });
      await pending.catch(() => {});
      expect(app.state.content).toBeNull();
    } finally {
      app.dispose();
    }
  },
);

it("reads all tool calls through a view-only encrypted host and rejects foreign messages and revoked access", async () => {
  const home = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-mobile-tools-")),
    ),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: f.pairing.relay,
      hostId: f.pairing.hostId,
      publicKey: f.host.publicKey,
      devices: {
        [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
      },
    }),
    { mode: 0o600 },
  );
  const db = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await db.createSession(cwd),
    foreign = await db.createSession(cwd);
  const calls = Array.from({ length: 40 }, (_, i) => ({
    id: `call-${i}`,
    name: "shell",
    arguments: {
      command: i === 0 ? "中文🌅".repeat(5000) : `read-only-example-${i}`,
    },
  }));
  const callEvent = await db.append(session.id, "message", {
    message: {
      role: "assistant",
      text: "",
      timestamp: 1,
      toolCalls: calls,
    },
  });
  await db.append(session.id, "message", {
    message: {
      role: "tool",
      name: "shell",
      isError: true,
      text: "合成失败结果",
      timestamp: 2,
    },
  });
  const foreignEvent = await db.append(foreign.id, "message", {
    message: {
      role: "assistant",
      text: "",
      timestamp: 3,
      toolCalls: calls,
    },
  });
  await db.close();
  const host = await serveSharedHost({ home, cwd, demo: true });
  const owner = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "mobile-tools-owner",
  });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const app = new MobileController(f.store, f.options);
  try {
    await owner.request("session.resume", { sessionId: session.id });
    await owner.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.select(session.id);
    await vi.waitFor(() => expect(app.state.messages).toHaveLength(2));
    expect(app.state.messages[0]?.message).toMatchObject({
      toolCalls: calls.slice(0, 32).map(({ id, name }) => ({ id, name })),
    });
    expect(app.state.messages[0]?.message).not.toHaveProperty(
      "toolCalls.0.arguments",
    );
    expect(app.state.messages[1]?.message).toMatchObject({
      name: "shell",
      isError: true,
    });
    const pages: string[] = [];
    for (let offset = 0; ;) {
      await app.readMessage(callEvent.seq, offset, "toolCalls");
      const page = app.state.content!.page!;
      pages.push(page.data);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("")).toBe(JSON.stringify(calls));
    expect(JSON.parse(pages.join(""))).toHaveLength(40);
    await expect(
      app.readMessage(foreignEvent.seq, 0, "toolCalls"),
    ).rejects.toThrow();
    expect(app.state.content?.page).toBeNull();
    await app.readMessage(callEvent.seq, 0, "toolCalls");
    await owner.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: null,
    });
    await vi.waitFor(() => expect(app.state.session).toBeNull());
    expect(app.state.content).toBeNull();
    await expect(
      app.readMessage(callEvent.seq, 0, "toolCalls"),
    ).rejects.toThrow();
    expect(
      f.sent.some((frame) =>
        [
          "prompt",
          "steer",
          "tool.manual",
          "approval.respond",
          "run.cancel",
        ].includes(frame.method),
      ),
    ).toBe(false);
  } finally {
    app.dispose();
    owner.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);

it("clears full-message pages on close, selection and background, fencing late responses", async () => {
  let resolve!: (page: unknown) => void;
  let delayed = false;
  const page = {
    data: "完整正文",
    total: 4,
    nextOffset: null,
    encoding: "utf16",
  };
  const f = fixture(undefined, async () =>
    delayed
      ? new Promise((done) => {
          resolve = done;
        })
      : page,
  );
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.readMessage(2);
    expect(app.state.content?.page?.data).toBe("完整正文");
    delayed = true;
    const pending = app.readMessage(2);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    app.closeMessage();
    resolve(page);
    await pending;
    expect(app.state.content).toBeNull();
    delayed = false;
    await app.readMessage(2);
    await app.select("s1");
    expect(app.state.content).toBeNull();
    await app.readMessage(2);
    app.suspend();
    expect(app.state.content).toBeNull();
    expect(
      f.sent
        .filter((frame) => frame.method === "messages.content")
        .every(
          (frame) =>
            frame.params.field === "text" && frame.params.limit === 8192,
        ),
    ).toBe(true);
  } finally {
    app.dispose();
  }
});
it("requires review, persists credentials, restores a bounded read-only view and locks revoked devices", async () => {
  const f = fixture();
  const app = new MobileController(f.store, f.options);
  try {
    expect(() => app.review("hikaro://pair#bad")).toThrow();
    expect(f.store.write).not.toHaveBeenCalled();
    app.review(f.uri());
    expect(app.state.phase).toBe("review");
    expect(f.sent).toEqual([]);
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() =>
      expect(app.state.messages[0]?.message.text).toBe("已恢复的结果"),
    );
    expect(f.credential).not.toBeNull();
    expect(JSON.stringify(app.state)).not.toContain(f.pairing.token);
    expect(JSON.stringify(app.state)).not.toContain(
      f.pairing.identity.secretKey,
    );
    await app.select("s1");
    expect(f.sent.some((frame) => frame.method === "session.resume")).toBe(
      true,
    );
    expect(
      f.sent.every((frame) =>
        [
          "hello",
          "session.current",
          "session.list",
          "messages.read",
          "session.resume",
          "command.receipt",
        ].includes(frame.method),
      ),
    ).toBe(true);
    f.close(1006);
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(
      f.sent.filter((frame) => frame.method === "session.resume"),
    ).toHaveLength(1);
    let finishErase!: () => void;
    const originalErase = f.store.erase.getMockImplementation()!;
    f.store.erase.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        finishErase = done;
      });
      await originalErase();
    });
    const switching = expect(app.select("s1")).rejects.toThrow();
    f.close(4003);
    await switching;
    await vi.waitFor(() => expect(finishErase).toBeTypeOf("function"));
    expect(app.state.error).toContain("正在移除失效");
    finishErase();
    await vi.waitFor(() => expect(app.state.phase).toBe("revoked"));
    expect(app.state.messages).toEqual([]);
    expect(f.store.erase).toHaveBeenCalled();
    expect(f.credential).toBeNull();
  } finally {
    app.dispose();
  }
});
it("fences a secure-store load when the app backgrounds or forgets, and never connects from it", async () => {
  const f = fixture();
  let resolve!: (value: string) => void;
  f.store.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const app = new MobileController(f.store, f.options);
  const restore = app.restore();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  app.suspend();
  resolve(JSON.stringify(f.pairing));
  await restore;
  expect(f.sent).toEqual([]);
  expect(app.state.phase).toBe("background");
  await app.forget();
  expect(app.state.phase).toBe("unpaired");
  app.dispose();
});
it("allows pairing again after removal finishes while the app is in the background", async () => {
  const f = fixture();
  const app = new MobileController(f.store, f.options);
  let finishErase!: () => void;
  const originalErase = f.store.erase.getMockImplementation()!;
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    const originalIdentity = app.notificationIdentity;
    f.store.erase.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        finishErase = done;
      });
      await originalErase();
    });
    const forgetting = app.forget();
    await vi.waitFor(() => expect(finishErase).toBeTypeOf("function"));
    app.suspend();
    finishErase();
    await forgetting;
    expect(app.state.phase).toBe("background");
    expect(f.credential).toBeNull();
    const sentBeforeRestore = f.sent.length;
    await app.restore();
    expect(app.state.phase).toBe("unpaired");
    expect(app.state.composer.record).toBeNull();
    expect(app.notificationIdentity).toBeNull();
    expect(f.sent).toHaveLength(sentBeforeRestore);
    expect(() => app.review(f.uri())).not.toThrow();
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(app.notificationIdentity).not.toBe(originalIdentity);
    expect(f.credential).not.toBeNull();
  } finally {
    finishErase?.();
    app.dispose();
  }
});
it("keeps a persisted enrollment after QR expiry but refuses a revoked token before opening a socket", async () => {
  const f = fixture();
  f.pairing.expires = Date.now() - 1;
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, {
    ...f.options,
    probe: async () => "revoked",
  });
  try {
    await app.restore();
    expect(app.state.phase).toBe("revoked");
    expect(f.sent).toEqual([]);
    expect(f.credential).toBeNull();
  } finally {
    app.dispose();
  }
});

it("restores the same granted host task after a lost selection acknowledgement, app recreation and host restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-mobile-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  const config = {
    relay: f.pairing.relay,
    hostId: f.pairing.hostId,
    publicKey: f.host.publicKey,
    devices: {
      [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
    },
  };
  await writeFile(join(home, "remote.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  let host = await serveSharedHost({ home, cwd, demo: true });
  let wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  let local = new ClientConnection(wire.scope, wire, clock);
  let app = new MobileController(f.store, f.options);
  try {
    await local.connected();
    const session = (await local.request("session.create")) as any;
    await local.request("session.create"); // A second, ungranted task must stay invisible.
    await local.request("session.resume", { sessionId: session.id });
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() =>
      expect(app.state.sessions.map((s) => s.id)).toEqual([session.id]),
    );
    f.dropResume();
    await expect(app.select(session.id)).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(app.state.session?.id).toBe(session.id));
    await vi.waitFor(() => expect(app.state.unknown).toBe(0));
    expect(f.sent.filter((f) => f.method === "session.resume")).toHaveLength(1);
    await local.request("prompt", { text: "mobile recovery proof" });
    await vi.waitFor(() => expect(local.state.busy).toBe(false));
    await vi.waitFor(() =>
      expect(
        app.state.messages.some((m) => m.message.role === "assistant"),
      ).toBe(true),
    );
    // Keep the long input within the demo context budget; cancel its slow echo.
    const fullText = "read".repeat(6000) + "中文🌅";
    await local.request("prompt", { text: fullText });
    await vi.waitFor(() =>
      expect(
        app.state.messages.some(
          (m) => m.message.textLength === fullText.length,
        ),
      ).toBe(true),
    );
    await local.request("cancel");
    await vi.waitFor(() => expect(local.state.busy).toBe(false));
    await app.history("latest");
    const text = app.state.messages.map((m) => m.message.text);
    const user = app.state.messages.find(
      (m) =>
        m.message.role === "user" && m.message.textLength === fullText.length,
    )!;
    expect(user.message.textLength).toBeGreaterThan(20000);
    // Match text beyond the list preview through the real encrypted RPC path.
    await app.inspection.searchMessages("中文🌅");
    expect(app.state.inspection.search?.items).toEqual([
      expect.objectContaining({ seq: user.seq, role: "user" }),
    ]);
    expect(app.state.inspection.search?.items[0]?.snippet).toContain("中文🌅");
    await app.readMessage(user.seq);
    expect(fullText.startsWith(app.state.content!.page!.data)).toBe(true);
    await app.readMessage(user.seq, 8190);
    expect(app.state.content!.page!.data.length).toBeLessThanOrEqual(8191);
    app.suspend();
    expect(app.state.content).toBeNull();
    expect(app.state.messages).toEqual([]);
    expect(local.state.session?.id).toBe(session.id);
    app.dispose();
    app = new MobileController(f.store, f.options);
    await app.restore();
    await vi.waitFor(() => {
      expect(app.state.phase).toBe("connected");
      expect(app.state.messages.map((m) => m.message.text)).toEqual(text);
    });
    app.suspend();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    host = await serveSharedHost({ home, cwd, demo: true });
    wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
    bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
    local = new ClientConnection(wire.scope, wire, clock);
    await local.connected();
    await app.restore();
    await vi.waitFor(() => {
      expect(app.state.phase).toBe("connected");
      expect(app.state.messages.map((m) => m.message.text)).toEqual(text);
    });
    expect(app.state.session?.id).toBe(session.id);
    expect(f.sent.filter((f) => f.method === "session.resume")).toHaveLength(1);
    await app.inspection.searchMessages("中文🌅");
    expect(app.state.inspection.search?.items[0]?.seq).toBe(user.seq);
    await app.readMessage(user.seq);
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: null,
    });
    await vi.waitFor(() => expect(app.state.session).toBeNull());
    await vi.waitFor(() => expect(app.state.sessions).toEqual([]));
    expect(app.state.messages).toEqual([]);
    expect(app.state.content).toBeNull();
    expect(app.state.inspection.search).toBeNull();
    await expect(app.inspection.searchMessages("中文🌅")).rejects.toThrow();
    await vi.waitFor(async () =>
      expect(await f.store.snapshots.load(pairingScope(f.pairing))).toBeNull(),
    );
  } finally {
    app.dispose();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);

it("manages mobile steering with a real host and confirms only the original identity without replay", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-mobile-steering-")),
  );
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge!: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: f.pairing.relay,
      hostId: f.pairing.hostId,
      publicKey: f.host.publicKey,
      devices: {
        [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
      },
    }),
    { mode: 0o600 },
  );
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await store.createSession(cwd);
  await store.insertPendingSteering(session.id, {
    id: "recovered-phone",
    text: "手机恢复项",
    scope: f.pairing.deviceId,
  });
  await store.insertPendingSteering(session.id, {
    id: "recovered-other",
    text: "其他身份恢复项",
    scope: "another-device",
  });
  await store.close();
  const host = await serveSharedHost({ home, cwd, demo: true });
  const wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const local = new ClientConnection(wire.scope, wire, clock);
  let app = new MobileController(f.store, f.options);
  try {
    await local.connected();
    await local.request("session.resume", { sessionId: session.id });
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "control",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.select(session.id);
    await vi.waitFor(() =>
      expect(app.state.composer.record?.session.id).toBe(session.id),
    );
    await app.steering.open(session.id);
    expect(app.state.steering.items).toHaveLength(2);
    await app.steering.inspect("recovered-other");
    await expect(app.steering.act("recovered-other", "resume")).rejects.toThrow(
      /original client/,
    );
    await app.steering.inspect("recovered-phone");
    await app.steering.act("recovered-phone", "resume");
    expect(app.state.busy).toBe(false);
    for (const text of ["手机第一条", "手机优先项", "手机删除项"]) {
      app.editDraft(session.id, text);
      await app.sendDraft(session.id, "steer");
      expect(app.state.composer.record?.text).toBe("");
    }
    await app.steering.refresh();
    const first = app.state.steering.items.find((i) =>
      i.title.includes("手机第一条"),
    )!;
    const priority = app.state.steering.items.find((i) =>
      i.title.includes("手机优先项"),
    )!;
    const removed = app.state.steering.items.find((i) =>
      i.title.includes("手机删除项"),
    )!;
    await app.steering.inspect(first.id);
    app.steering.edit("手机修改后");
    await app.steering.act(first.id, "edit");
    await app.steering.inspect(priority.id);
    await app.steering.act(priority.id, "first");
    await app.steering.inspect(removed.id);
    await app.steering.act(removed.id, "remove");
    expect(app.state.steering.items[0]?.id).toBe(priority.id);
    expect(app.state.steering.items.some((i) => i.id === removed.id)).toBe(
      false,
    );
    await app.steering.close();
    app.editDraft(session.id, "丢回执补充项");
    f.dropReply("steer");
    await expect(app.sendDraft(session.id, "steer")).rejects.toThrow(
      /unknown/i,
    );
    app.dispose();
    app = new MobileController(f.store, f.options);
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(async () => {
      await app.reconcileDraft();
      expect(app.state.composer.record?.text).toBe("");
    });
    expect(f.sent.filter((f) => f.method === "steer")).toHaveLength(4);
    expect(f.sent.filter((f) => f.method === "prompt")).toHaveLength(0);
    expect(app.state.busy).toBe(false);
    await app.steering.open(session.id);
    await app.steering.close();
    app.editDraft(session.id, "明确开始任务");
    await app.sendDraft(session.id);
    await vi.waitFor(() => expect(app.state.runStatus).toBe("completed"));
    await app.history();
    expect(
      app.state.messages
        .filter((m) => m.message.role === "user")
        .map((m) => m.message.text),
    ).toEqual([
      "明确开始任务",
      "手机优先项",
      "手机恢复项",
      "手机修改后",
      "丢回执补充项",
    ]);
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    await vi.waitFor(() => expect(app.state.canSteer).toBe(false));
    await expect(app.steering.open(session.id)).rejects.toThrow(/control/);
  } finally {
    app.dispose();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);

it("sends mobile drafts through a real host, queues while busy, and recovers a lost prompt reply without replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-mobile-composer-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: f.pairing.relay,
      hostId: f.pairing.hostId,
      publicKey: f.host.publicKey,
      devices: {
        [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
      },
    }),
    { mode: 0o600 },
  );
  const host = await serveSharedHost({ home, cwd, demo: true });
  const wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const local = new ClientConnection(wire.scope, wire, clock);
  let app = new MobileController(f.store, f.options);
  try {
    await local.connected();
    const session = (await local.request("session.create")) as any;
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "control",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.select(session.id);
    await vi.waitFor(() =>
      expect(app.state.composer.record?.session.id).toBe(session.id),
    );
    expect(app.state.canSend).toBe(true);
    app.editDraft(session.id, "来自手机的第一条要求");
    await app.sendDraft(session.id);
    expect(app.state.composer.record?.text).toBe("");
    await vi.waitFor(() => expect(app.state.runStatus).toBe("completed"));
    const running = local.request("tool.manual", {
      command:
        "printf ready > ready.txt; while [ ! -f release.txt ]; do sleep 0.05; done",
      unrestricted: true,
    });
    void running.catch(() => {});
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(1));
    await app.respondApproval(app.state.approvals[0]!.id, true);
    await vi.waitFor(async () =>
      expect(await readFile(join(cwd, "ready.txt"), "utf8")).toBe("ready"),
    );
    expect(app.state.busy).toBe(true);
    app.editDraft(session.id, "手机排队的第二条要求");
    await app.sendDraft(session.id);
    expect(app.state.composer.record?.text).toBe("");
    await app.history();
    expect(
      app.state.messages.some((m) => m.message.text === "手机排队的第二条要求"),
    ).toBe(false);
    await writeFile(join(cwd, "release.txt"), "go");
    await running;
    await vi.waitFor(async () => {
      await app.history();
      expect(
        app.state.messages.filter(
          (m) => m.message.text === "手机排队的第二条要求",
        ),
      ).toHaveLength(1);
      expect(app.state.runStatus).toBe("completed");
    });
    app.editDraft(session.id, "丢回执也只执行一次");
    f.dropReply("prompt");
    await expect(app.sendDraft(session.id)).rejects.toThrow(/unknown/i);
    app.dispose();
    app = new MobileController(f.store, f.options);
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(async () => {
      await app.reconcileDraft();
      expect(app.state.composer.record?.text).toBe("");
    });
    await app.history();
    for (const text of [
      "来自手机的第一条要求",
      "手机排队的第二条要求",
      "丢回执也只执行一次",
    ])
      expect(
        app.state.messages.filter(
          (m) => m.message.role === "user" && m.message.text === text,
        ),
      ).toHaveLength(1);
    expect(f.sent.filter((f) => f.method === "prompt")).toHaveLength(3);
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    await vi.waitFor(() => expect(app.state.canSend).toBe(false));
    app.editDraft(session.id, "无权限时保留草稿");
    await expect(app.sendDraft(session.id)).rejects.toThrow(/control/);
    expect(app.state.composer.record?.text).toBe("无权限时保留草稿");
    expect(f.sent.filter((f) => f.method === "prompt")).toHaveLength(3);
  } finally {
    app.dispose();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);

it("arbitrates approvals and run-specific stops with a real host, reconciling lost replies without replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-mobile-control-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  let bridge: SharedHostClient;
  const f = fixture({
    request: (frame) => dispatchRemote(bridge, f.pairing.deviceId, frame),
    subscribe: (fn) => bridge.subscribe(fn),
  });
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      relay: f.pairing.relay,
      hostId: f.pairing.hostId,
      publicKey: f.host.publicKey,
      devices: {
        [f.pairing.deviceId]: { publicKey: f.pairing.identity.publicKey },
      },
    }),
    { mode: 0o600 },
  );
  const host = await serveSharedHost({ home, cwd, demo: true });
  const wire = await SharedHostClient.connect({ home, cwd, clientId: "owner" });
  bridge = await SharedHostClient.connect({ home, cwd, mode: "bridge" });
  const local = new ClientConnection(wire.scope, wire, clock);
  const app = new MobileController(f.store, f.options);
  try {
    await local.connected();
    const session = (await local.request("session.create")) as any;
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "control",
    });
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.select(session.id);
    await vi.waitFor(() => expect(app.state.sessionRole).toBe("control"));
    const command = () =>
      local.request("tool.manual", {
        command: "printf approved > approved.txt",
        unrestricted: true,
      });
    const first = command();
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(1));
    const id = app.state.approvals[0]!.id;
    expect(app.state.approvals[0]!.arguments).toMatchObject({
      command: "printf approved > approved.txt",
    });
    const race = await Promise.allSettled([
      app.respondApproval(id, true),
      local.request("approval.respond", { id, allow: true }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await first;
    expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("approved");
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(0));
    await expect(app.respondApproval(id, true)).rejects.toThrow(/expired/);
    const second = command();
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(1));
    const next = app.state.approvals[0]!.id;
    const count = f.sent.filter((f) => f.method === "approval.respond").length;
    f.dropReply("approval.respond");
    await expect(app.respondApproval(next, false)).rejects.toThrow(/unknown/i);
    expect(await second).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() => expect(app.state.unknown).toBe(0));
    expect(f.sent.filter((f) => f.method === "approval.respond")).toHaveLength(
      count + 1,
    );
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "view",
    });
    await vi.waitFor(() => expect(app.state.sessionRole).toBe("view"));
    await expect(app.respondApproval(next, true)).rejects.toThrow(/control/);
    await expect(app.stopRun(session.id, "expired")).rejects.toThrow(/control/);
    await local.request("session.access", {
      deviceId: f.pairing.deviceId,
      role: "control",
    });
    const running = local.request("tool.manual", {
      command:
        "printf '%s' $$ > shell.pid; printf started > started.txt; sleep 30",
      unrestricted: true,
    });
    void running.catch(() => {}); // The assertion below still observes failures; cleanup may close the connection first.
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(1));
    await app.respondApproval(app.state.approvals[0]!.id, true);
    await vi.waitFor(async () =>
      expect(await readFile(join(cwd, "started.txt"), "utf8")).toBe("started"),
    );
    const shellPid = Number(await readFile(join(cwd, "shell.pid"), "utf8"));
    expect(Number.isSafeInteger(shellPid) && shellPid > 1).toBe(true);
    expect(() => process.kill(shellPid, 0)).not.toThrow();
    const runId = app.state.runId!;
    expect(app.state.canStopRun).toBe(true);
    f.dropReply("run.cancel");
    await expect(app.stopRun(session.id, runId)).rejects.toThrow(/unknown/i);
    expect(await running).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() => expect(app.state.runStatus).toBe("cancelled"));
    await vi.waitFor(() => expect(app.state.unknown).toBe(0));
    expect(() => process.kill(shellPid, 0)).toThrow();
    expect(
      f.sent.filter((frame) => frame.method === "run.cancel"),
    ).toHaveLength(1);
    expect(
      app.state.receipts.find((r) => r.method === "run.cancel"),
    ).toMatchObject({ status: "completed", runId });
    const following = command();
    void following.catch(() => {});
    await vi.waitFor(() => expect(app.state.approvals).toHaveLength(1));
    const nextRun = app.state.runId!;
    expect(nextRun).not.toBe(runId);
    await expect(app.stopRun(session.id, runId)).rejects.toThrow(/expired/);
    await expect(
      local.request("run.cancel", { sessionId: session.id, runId }),
    ).rejects.toThrow(/no longer active/);
    expect(app.state.runStatus).toBe("running");
    expect(app.state.approvals).toHaveLength(1);
    await app.stopRun(session.id, nextRun);
    expect(await following).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(app.state.runStatus).toBe("cancelled"));
  } finally {
    app.dispose();
    local.close();
    wire.close();
    bridge.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20000);

it("rechecks notification task authority without mutations and rejects stale identities", async () => {
  const f = fixture();
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() => expect(app.state.loading).toBe(false));
    const identity = app.notificationIdentity!;
    f.sent.length = 0;
    expect(await app.refreshNotificationTasks(identity)).toBe(true);
    expect(app.state.sessions.map((session) => session.id)).toEqual(["s1"]);
    expect(f.sent.map((frame) => frame.method)).toEqual(["session.list"]);
    expect(f.sent[0].params).toEqual({ offset: 0, limit: 50 });
    expect(await app.refreshNotificationTasks("old-pairing")).toBe(false);
    app.suspend();
    expect(app.notificationIdentity).toBe(identity);
    expect(await app.refreshNotificationTasks(identity)).toBe(false);
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(app.notificationIdentity).toBe(identity);
    await app.forget();
    expect(app.notificationIdentity).toBeNull();
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    expect(app.notificationIdentity).not.toBe(identity);
    expect(await app.refreshNotificationTasks(identity)).toBe(false);
  } finally {
    app.dispose();
  }
});

it("keeps drafts and the encrypted connection through permission sheets, but hides and restores actual background content", async () => {
  const f = fixture(undefined, undefined, { sessionRole: "control" });
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    const change = mobileLifecycle(app, "active");
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() =>
      expect(app.state.composer.record?.session.id).toBe("s1"),
    );
    app.editDraft("s1", "权限窗口期间保留的草稿");
    await app.saveDraft();
    const identity = app.pushIdentity;
    const connections = f.sent.filter(
      (frame) => frame.method === "hello",
    ).length;
    change("inactive");
    change("active");
    expect(app.pushIdentity).toBe(identity);
    expect(app.state.composer.record?.text).toBe("权限窗口期间保留的草稿");
    expect(f.sent.filter((frame) => frame.method === "hello")).toHaveLength(
      connections,
    );
    change("background");
    expect(app.state.phase).toBe("background");
    expect(app.state.messages).toEqual([]);
    expect(app.state.composer.record).toBeNull();
    change("active");
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() =>
      expect(app.state.composer.record?.text).toBe("权限窗口期间保留的草稿"),
    );
    expect(app.pushIdentity).toBe(identity);
    expect(f.sent.filter((frame) => frame.method === "hello")).toHaveLength(
      connections + 1,
    );
    expect(f.sent.filter((frame) => frame.method === "prompt")).toEqual([]);
  } finally {
    app.dispose();
  }
});

it("rejects a notification refresh when its encrypted response arrives after a newer page", async () => {
  const f = fixture();
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() => expect(app.state.loading).toBe(false));
    let finish!: (rows: unknown[]) => void;
    f.delayNextList(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRefresh = app.refreshNotificationTasks(app.notificationIdentity!);
    await app.tasks(50);
    finish([]);
    expect(await oldRefresh).toBe(false);
    expect(app.state.offset).toBe(50);
    expect(app.state.sessions.map((session) => session.id)).toEqual(["s1"]);
  } finally {
    app.dispose();
  }
});

it("does not repopulate task data when a notification refresh loses its pairing", async () => {
  const f = fixture();
  await f.store.write(JSON.stringify(f.pairing));
  const app = new MobileController(f.store, f.options);
  try {
    await app.restore();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await vi.waitFor(() => expect(app.state.loading).toBe(false));
    let finish!: (rows: unknown[]) => void;
    f.delayNextList(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRefresh = app
      .refreshNotificationTasks(app.notificationIdentity!)
      .catch(() => false);
    await app.forget();
    finish([]);
    expect(await oldRefresh).toBe(false);
    expect(app.state.phase).toBe("unpaired");
    expect(app.state.sessions).toEqual([]);
  } finally {
    app.dispose();
  }
});

it("reads model-reported plan progress read-only and reports old hosts without guessing", async () => {
  const f = fixture();
  const progress = {
    planId: randomUUID(),
    title: "手机计划",
    steps: [
      { text: "修改文件", status: "completed", note: "已写入" },
      { text: "运行测试", status: "in_progress" },
    ],
  };
  let reply: unknown = { active: false, progress };
  let gate: Promise<void> | undefined;
  f.setPlanRead(async () => {
    await gate;
    return reply;
  });
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.readPlanProgress();
    expect(app.state.plan).toMatchObject({
      status: "ready",
      progress: { title: "手机计划", steps: [{ status: "completed" }, {}] },
    });
    const frame = f.sent.filter((s) => s.method === "plan.read").at(-1);
    expect(frame.params.sessionId).toBeTruthy();

    reply = { active: true, progress: null };
    await app.readPlanProgress();
    expect(app.state.plan).toMatchObject({ status: "none" });

    reply = { active: false };
    await app.readPlanProgress();
    expect(app.state.plan).toMatchObject({ status: "unsupported" });

    reply = {
      active: false,
      progress: { ...progress, steps: [{ text: "x", status: "done" }] },
    };
    await expect(app.readPlanProgress()).rejects.toThrow();
    expect(app.state.plan).toMatchObject({ status: "error" });

    // A late response must not reappear after the panel closes.
    reply = { active: false, progress };
    let open!: () => void;
    gate = new Promise<void>((done) => (open = done));
    const reads = f.sent.filter((s) => s.method === "plan.read").length;
    const late = app.readPlanProgress();
    await vi.waitFor(() =>
      expect(f.sent.filter((s) => s.method === "plan.read").length).toBe(
        reads + 1,
      ),
    );
    app.closePlan();
    open();
    await late.catch(() => {});
    expect(app.state.plan).toBeNull();
    expect(
      f.sent.some((s) =>
        ["plan.set", "plan.execute", "prompt", "steer"].includes(s.method),
      ),
    ).toBe(false);
  } finally {
    app.dispose();
  }
});
