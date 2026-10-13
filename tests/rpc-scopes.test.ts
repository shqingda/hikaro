import { it, expect } from "vitest";
import { ProcessClient } from "../packages/protocol/src/client.ts";
import { dispatchRemote } from "../packages/remote/src/host.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
it("keeps device scopes independent and preserves command idempotency", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-scopes-"));
  const client = new ProcessClient(process.execPath, [
    "--import",
    "tsx",
    resolve("apps/cli/src/index.ts"),
    "--rpc",
    "--demo",
    "--home",
    home,
  ]);
  try {
    const a = await client.request("session.create", {}, false, { scope: "a" });
    const b = await client.request("session.create", {}, false, { scope: "b" });
    expect(a.id).not.toBe(b.id);
    expect(
      (await client.request("session.current", {}, false, { scope: "a" }))
        .session.id,
    ).toBe(a.id);
    await client.request("prompt", { text: "hello" }, false, {
      scope: "a",
      id: "stable",
    });
    expect(
      await client.request("prompt", { text: "hello" }, false, {
        scope: "a",
        id: "stable",
      }),
    ).toEqual({ duplicate: true });
    expect(
      (await client.request("session.current", {}, false, { scope: "b" })).busy,
    ).toBe(false);
    await client.request("cancel", {}, false, { scope: "a" });
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}, 10000);
it("does not trust a handset-provided scope", async () => {
  let seen: any;
  await dispatchRemote(
    {
      async request(...args: any[]) {
        seen = args;
        return {};
      },
    },
    "authenticated-device",
    { id: "request", scope: "spoofed", method: "session.list", params: {} },
  );
  expect(seen[3].scope).toBe("authenticated-device");
  expect(seen[3].id).toHaveLength(64);
});
