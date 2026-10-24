import { it, expect, vi } from "vitest";
import {
  MobileController,
  pairingScope,
} from "../apps/mobile/src/controller.ts";
import { fixture } from "./helpers/mobile-controller.ts";
import { randomUUID } from "node:crypto";
import { mobileLifecycle } from "../apps/mobile/src/lifecycle.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";
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

it("reads child agents and background terminals read-only without holding the queue", async () => {
  const f = fixture();
  f.setExecutionRead(async (params) =>
    params.kind === "children"
      ? [
          {
            id: "c1",
            title: "Child task",
            state: "completed",
            detail: "Task: Child task",
            actions: [{ value: "stop", label: "Stop child agent…" }],
          },
          {
            id: "c2",
            title: "  ↳ Grandchild",
            state: "interrupted · level 2",
            detail: "Task: Grandchild",
            actions: [],
          },
        ]
      : [
          {
            id: "t1",
            title: "npm test",
            state: "unknown after host restart",
            detail: "Saved by an earlier host.",
            actions: [],
          },
        ],
  );
  const app = new MobileController(f.store, f.options);
  try {
    app.review(f.uri());
    await app.confirm();
    await vi.waitFor(() => expect(app.state.phase).toBe("connected"));
    await app.readBackground();
    expect(app.state.background).toMatchObject({
      status: "ready",
      children: [
        { title: "Child task", state: "completed" },
        { title: "  ↳ Grandchild", state: "interrupted · level 2" },
      ],
      terminals: [{ title: "npm test", state: "unknown after host restart" }],
    });
    const reads = f.sent.filter((s) => s.method === "execution.read");
    expect(reads.map((s) => s.params.kind).sort()).toEqual([
      "children",
      "terminals",
    ]);
    expect(reads.every((s) => s.params.token === undefined)).toBe(true);
    expect(
      f.sent.some((s) =>
        ["execution.hold", "execution.action", "prompt"].includes(s.method),
      ),
    ).toBe(false);
    app.closeBackground();
    expect(app.state.background).toBeNull();
  } finally {
    app.dispose();
  }
});
