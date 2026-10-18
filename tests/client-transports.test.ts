import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessClient } from "../packages/protocol/src/client.ts";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { remoteConnection } from "../packages/remote/src/connection.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../packages/crypto/src/index.ts";

const clock = {
  id: randomUUID,
  schedule: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

it("converges local and encrypted remote views on real SQLite, preserving unknown outcomes across reconnect", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-client-transport-"));
  const host = new ProcessClient(process.execPath, [
    "--import",
    "tsx",
    resolve("apps/cli/src/index.ts"),
    "--rpc",
    "--demo",
    "--home",
    home,
  ]);
  const local = new ClientConnection("desktop", host, clock);
  const identity = createIdentity(),
    device = createIdentity(),
    deviceId = randomToken();
  let active: any,
    promptCount = 0,
    dropPromptResponse = false,
    notificationCount = 0;
  let stopForwarding: (() => void) | undefined;
  const remote = remoteConnection(
    {
      v: 1,
      relay: "wss://fixture.example",
      hostId: randomToken(),
      deviceId,
      token: randomToken(),
      identity: device,
      hostKey: identity.publicKey,
      expires: Date.now() + 300000,
    },
    clock,
    {
      reconnectMs: 1,
      heartbeatMs: 60000,
      socket: () => {
        const channel = new SecureChannel("host", identity, device.publicKey);
        const socket: any = {
          readyState: 1,
          bufferedAmount: 0,
          send: (text: string) => {
            if (text === "ping") {
              queueMicrotask(() => socket.onmessage?.({ data: "pong" }));
              return;
            }
            const result = channel.receive(text);
            if (result.reply)
              queueMicrotask(() => socket.onmessage?.({ data: result.reply }));
            if (result.data) {
              const frame = result.data as any;
              if (frame.method === "prompt") promptCount++;
              void dispatchRemote(host, deviceId, frame).then((result) => {
                if (
                  socket.readyState !== 1 ||
                  (dropPromptResponse && frame.method === "prompt")
                )
                  return;
                socket.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: deviceId,
                    id: frame.id,
                    result,
                  }),
                });
              });
            }
          },
          close: (code: number) => {
            socket.readyState = 3;
            stopForwarding?.();
            socket.onclose?.({ code });
          },
        };
        active = socket;
        stopForwarding = host.subscribe((frame) => {
          if (frame.scope !== deviceId || socket.readyState !== 1) return;
          if (frame.type === "event" && frame.event.type === "text.delta") {
            notificationCount++;
            if (notificationCount === 2) return; // A real revision gap, repaired by a read.
            if (notificationCount === 1)
              socket.onmessage?.({ data: channel.send(frame) }); // Duplicate RPC frame, fresh crypto sequence.
          }
          socket.onmessage?.({ data: channel.send(frame) });
        });
        queueMicrotask(() => {
          socket.onopen?.();
          socket.onmessage?.({ data: channel.hello() });
        });
        return socket;
      },
    },
  );
  try {
    await local.connected();
    remote.connect();
    await vi.waitFor(() => expect(remote.client.state.canAct).toBe(true));
    const session = (await local.request("session.create")) as any;
    await local.synchronize();
    await remote.client.request("session.resume", { sessionId: session.id });
    await remote.client.synchronize();
    await local.synchronize();
    dropPromptResponse = true;
    const pending = remote.client.request("prompt", { text: "one execution" });
    const rejected = expect(pending).rejects.toThrow(/unknown/i);
    await vi.waitFor(() => expect(promptCount).toBe(1));
    active.close(1006);
    await rejected;
    await vi.waitFor(() => expect(remote.client.state.canAct).toBe(true));
    await vi.waitFor(() => expect(local.state.runStatus).toBe("completed"), {
      timeout: 5000,
    });
    await remote.client.synchronize();
    const unknown = remote.client.receipts.find((r) => r.method === "prompt")!;
    expect(unknown.status).toBe("unknown");
    await remote.client.request("command.receipt", { commandId: unknown.id });
    expect(
      remote.client.receipts.find((r) => r.id === unknown.id)?.status,
    ).toBe("completed");
    expect(promptCount).toBe(1);
    expect(notificationCount).toBeGreaterThan(2);
    await local.synchronize();
    expect(local.state.session?.title).toBe("one execution");
    expect(remote.client.state).toMatchObject({
      session: local.state.session,
      cursor: local.state.cursor,
      runId: local.state.runId,
      runStatus: "completed",
      busy: false,
    });
    await local.request("session.rename", { title: "协议搜索" });
    const matches = (await local.request("session.list", {
      query: "协议",
    })) as any[];
    expect(matches[0].id).toBe(session.id);
    await local.synchronize();
    await local.request("draft.save", { text: "still unsent" });
    for (let i = 0; i < 65; i++)
      await local.request("draft.save", { text: "still unsent" });
    expect(await remote.client.request("draft.read")).toEqual({
      text: "still unsent",
    });
    const model = (await local.request("model.read")) as any;
    expect(model.current).toMatchObject({ provider: "demo", model: "offline" });
    const page = (await local.request("messages.read")) as any;
    expect(
      (
        (await local.request("messages.content", {
          seq: page.items[0].seq,
          limit: 3,
        })) as any
      ).data,
    ).toBe("one");
    const exported = (await local.request("session.export")) as any;
    expect(exported.text).toContain("one execution");
    await expect(
      local.request("messages.content", {
        sessionId: randomUUID(),
        seq: page.items[0].seq,
      }),
    ).rejects.toThrow(/workspace|session/i);
  } finally {
    remote.close();
    local.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
