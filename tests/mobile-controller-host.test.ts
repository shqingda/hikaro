import { it, expect, vi } from "vitest";
import {
  MobileController,
  pairingScope,
} from "../apps/mobile/src/controller.ts";
import { fixture, clock } from "./helpers/mobile-controller.ts";
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
import { SQLiteStore } from "../packages/storage/src/index.ts";
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
