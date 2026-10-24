import { expect, it, vi } from "vitest";
import {
  MobileComposer,
  parseDraft,
  type DraftRecord,
  type DraftStore,
} from "../apps/mobile/src/composer.ts";

const session = { id: "one", title: "任务", cwd: "/workspace", createdAt: 1 };
it("preserves the submission method across recovery and accepts older prompt drafts", async () => {
  const { app, store } = fixture();
  await app.select(session);
  app.edit(session.id, "补充要求");
  await expect(
    app.send(
      session.id,
      "steer-id",
      async () => {
        throw Error("lost reply");
      },
      "steer",
    ),
  ).rejects.toThrow("lost reply");
  const reopened = new MobileComposer(store, () => {});
  reopened.bind("device-a");
  await reopened.select();
  expect(reopened.state.record?.submission).toMatchObject({
    id: "steer-id",
    method: "steer",
  });
  expect(
    parseDraft(
      JSON.stringify({
        session,
        text: "old",
        submission: { id: "old", status: "unknown" },
      }),
    ).submission?.method,
  ).toBe("prompt");
});
function fixture() {
  const rows = new Map<string, DraftRecord>();
  const store: DraftStore = {
    load: vi.fn(async (scope, id) =>
      structuredClone(
        id
          ? (rows.get(scope + id) ?? null)
          : ([...rows.entries()]
              .filter(([key]) => key.startsWith(scope))
              .at(-1)?.[1] ?? null),
      ),
    ),
    save: vi.fn(async (scope, record) => {
      rows.set(scope + record.session.id, structuredClone(record));
    }),
  };
  const app = new MobileComposer(store, () => {});
  app.bind("device-a");
  return { app, store, rows };
}
it.each([false, true])(
  "keeps burst edits when an older in-flight save settles (failure=%s)",
  async (failOldSave) => {
    const { app, store, rows } = fixture();
    const snapshots: string[] = [];
    let releaseSave!: () => void;
    let markStarted!: () => void;
    const saving = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const save = store.save;
    const delayedStore: DraftStore = {
      load: store.load,
      save: vi.fn(async (scope, record) => {
        if (record.text === "old") {
          markStarted();
          await saving;
          if (failOldSave) throw Error("old write failed");
        }
        await save(scope, record);
      }),
    };
    const editor = new MobileComposer(delayedStore, (state) => {
      snapshots.push(state.record?.text ?? "");
    });
    editor.bind("device-a");
    await editor.select(session);
    editor.edit(session.id, "old");
    await started;
    const oldSave = editor.flush();
    // Observe the rejected promise before releasing the delayed write.
    const oldOutcome = oldSave.then(
      () => "saved",
      () => "failed",
    );
    for (const text of ["中文", "中文\n", "中文\n😀", "中文\n", "中文\n第二行"])
      editor.edit(session.id, text);
    const final = "中文\n第二行";
    expect(editor.state.record?.text).toBe(final);
    expect(editor.state.saving).toBe(true);
    snapshots.length = 0;
    releaseSave();
    await editor.flush();
    expect(await oldOutcome).toBe(failOldSave ? "failed" : "saved");
    expect(snapshots.every((text) => text === final)).toBe(true);
    expect(editor.state).toMatchObject({ saving: false, error: null });
    expect(rows.get("device-aone")?.text).toBe(final);
    expect(delayedStore.save).toHaveBeenCalledTimes(2);
    // A fresh composer must see the durable final text, not only the UI snapshot.
    await app.select(session);
    expect(app.state.record?.text).toBe(final);
  },
);
it("restores offline drafts after recreation and isolates device and task identities", async () => {
  const { app, store, rows } = fixture();
  const snapshot = { ...session, modelSelection: { provider: "demo" } };
  await app.select(snapshot);
  app.edit(session.id, "第一行\n😀第二行");
  await app.flush();
  expect(rows.get("device-aone")?.session).not.toHaveProperty("modelSelection");
  const reopened = new MobileComposer(store, () => {});
  reopened.bind("device-a");
  await reopened.select();
  expect(reopened.state.record).toMatchObject({
    session,
    text: "第一行\n😀第二行",
  });
  await reopened.select({ ...session, id: "two" });
  expect(reopened.state.record?.text).toBe("");
  reopened.bind("device-b");
  await reopened.select(session);
  expect(reopened.state.record?.text).toBe("");
});
it("fences late loads and retains visible unsaved text on write failure", async () => {
  const { app, store } = fixture();
  let release!: (record: DraftRecord | null) => void;
  vi.mocked(store.load).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = app.select(session);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(() => app.edit(session.id, "new")).toThrow(/loading/i);
  const next = app.select({ ...session, id: "two" });
  release({ session, text: "obsolete" });
  await Promise.all([old, next]);
  expect(app.state.record?.session.id).toBe("two");
  vi.mocked(store.save).mockRejectedValueOnce(Error("disk full"));
  app.edit("two", "别丢这个草稿");
  await expect(app.flush()).rejects.toThrow("disk full");
  expect(app.state.record?.text).toBe("别丢这个草稿");
  expect(app.state.error).toBeTruthy();
  await expect(app.select(session)).rejects.toThrow();
  await app.retrySave();
  await app.select(session);
  expect(app.state.record?.text).toBe("");
});
it("persists text and command ID before dispatch and reconciles lost replies without replay", async () => {
  const { app, rows } = fixture();
  await app.select(session);
  app.edit(session.id, "执行一次");
  const send = vi.fn(async () => {
    expect(rows.get("device-aone")).toMatchObject({
      text: "执行一次",
      submission: { id: "stable" },
    });
    throw Error("connection lost");
  });
  await expect(app.send(session.id, "stable", send)).rejects.toThrow(
    "connection lost",
  );
  expect(app.state.record).toMatchObject({
    text: "执行一次",
    submission: { id: "stable" },
  });
  expect(() => app.edit(session.id, "duplicate")).toThrow(/unresolved/i);
  await app.reconcile(async (id) => {
    expect(id).toBe("stable");
    return "completed";
  });
  expect(app.state.record?.text).toBe("");
  expect(send).toHaveBeenCalledTimes(1);
});
it("never clears a newer task and fences queued writes after identity removal", async () => {
  const { app, store, rows } = fixture();
  await app.select(session);
  app.edit(session.id, "original");
  await app.flush();
  let complete!: () => void;
  const sending = app.send(
    session.id,
    "id",
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  await app.select({ ...session, id: "two" });
  app.edit("two", "newer");
  complete();
  await sending;
  expect(app.state.record?.text).toBe("newer");
  await app.flush();
  expect(rows.get("device-aone")?.text).toBe("");
  vi.mocked(store.save).mockClear();
  app.edit("two", "late");
  app.bind(null);
  await app.flush();
  expect(store.save).not.toHaveBeenCalled();
});
it("preserves initiated background saves but never dispatches after a selection race", async () => {
  const { app, rows } = fixture();
  await app.select(session);
  app.edit(session.id, "background");
  app.hide();
  await app.flush();
  expect(rows.get("device-aone")?.text).toBe("background");
  await app.select(session);
  const dispatch = vi.fn(async () => {});
  const pending = app.send(session.id, "race", dispatch);
  app.hide();
  await expect(pending).rejects.toThrow(/changed/i);
  expect(dispatch).not.toHaveBeenCalled();
});

it("coalesces unsaved edits and preserves text when accepted-result cleanup fails", async () => {
  const { app, store, rows } = fixture();
  await app.select(session);
  app.edit(session.id, "a");
  app.edit(session.id, "ab");
  app.edit(session.id, "abc");
  await app.flush();
  expect(store.save).toHaveBeenCalledTimes(1);
  expect(rows.get("device-aone")?.text).toBe("abc");
  await expect(
    app.send(session.id, "once", async () => {
      vi.mocked(store.save).mockRejectedValueOnce(Error("disk full"));
    }),
  ).rejects.toThrow("disk full");
  expect(app.state.record?.text).toBe("abc");
  expect(app.state.record?.submission?.id).toBe("once");
  await app.reconcile(async () => "failed");
  expect(app.state.record?.text).toBe("abc");
  await app.restoreDraft(session.id);
  expect(app.state.record).toMatchObject({ text: "abc" });
  expect(app.state.record?.submission).toBeUndefined();
});
