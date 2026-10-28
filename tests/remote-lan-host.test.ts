import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { serveSharedHost } from "../apps/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { serveRemote } from "../packages/remote/src/host.ts";
import {
  RemoteClient,
  type RemoteSocket,
} from "../packages/remote/src/client.ts";
import {
  keychainStore,
  writeConfig,
  readConfig,
} from "../packages/remote/src/host-store.ts";
import { createIdentity, randomToken } from "../packages/crypto/src/index.ts";

it("LAN routes encrypted commands through the real shared host and keeps task access restrictions", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-lan-host-")),
  );
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const identity = createIdentity(),
    device = createIdentity(),
    deviceId = randomToken(),
    hostId = randomToken();
  const secret = { identity, token: randomToken() };
  const getSecret = vi
    .spyOn(keychainStore, "get")
    .mockResolvedValue(JSON.stringify(secret));
  const activate = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const approveDevice = vi.fn().mockResolvedValue(false);
  await writeConfig(home, {
    relay: "wss://127.0.0.1:1",
    hostId,
    publicKey: identity.publicKey,
    devices: {
      [deviceId]: {
        publicKey: device.publicKey,
        approved: true,
        expires: Date.now() + 300000,
      },
    },
  });
  const host = await serveSharedHost({ home, cwd, demo: true });
  const owner = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "lan-owner",
  });
  const bridge = await serveRemote({
    home,
    cwd,
    lan: true,
    lanPort: 0,
    approveDevice,
  });
  const remote = new RemoteClient(
    {
      v: 1,
      relay: "wss://127.0.0.1:1",
      hostId,
      deviceId,
      token: randomToken(),
      identity: device,
      hostKey: identity.publicKey,
      expires: Date.now() + 300000,
      lan: [`ws://192.168.1.20:${bridge.lanPort}`],
    },
    {
      socket(url, protocols) {
        return new WebSocket(
          url.replace("192.168.1.20", "127.0.0.1"),
          protocols,
        ) as unknown as RemoteSocket;
      },
    },
  );
  try {
    await owner.request("hello");
    const session = (await owner.request("session.create")) as { id: string };
    await owner.request("session.create");
    await owner.request("session.resume", { sessionId: session.id });
    const connected = new Promise<void>((resolve) =>
      remote.subscribe((m) => {
        if (m.type === "connection" && m.status === "connected") resolve();
      }),
    );
    remote.connect();
    await connected;
    expect(approveDevice).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(
      expect.stringContaining("/activate"),
      expect.objectContaining({ method: "POST" }),
    );
    expect((await readConfig(home)).devices[deviceId]).toEqual({
      publicKey: device.publicKey,
    });
    await remote.request("hello");
    expect(await remote.request("session.list")).toEqual([]);
    await owner.request("session.access", { deviceId, role: "view" });
    const tasks = (await remote.request("session.list")) as Array<{
      id: string;
    }>;
    expect(tasks.map((s) => s.id)).toEqual([session.id]);
    await remote.request("session.resume", { sessionId: session.id });
    await expect(
      remote.request("prompt", { text: "must be rejected" }),
    ).rejects.toThrow();
    await owner.request("session.access", { deviceId, role: null });
    expect(await remote.request("session.list")).toEqual([]);
    const blocked = new Promise<void>((resolve) =>
      remote.subscribe((message) => {
        if (message.type === "connection" && message.status === "blocked")
          resolve();
      }),
    );
    const config = await readConfig(home);
    delete config.devices[deviceId];
    await writeConfig(home, config);
    await blocked;
  } finally {
    remote.close();
    await bridge.close();
    await owner.close();
    await host.close();
    getSecret.mockRestore();
    activate.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
