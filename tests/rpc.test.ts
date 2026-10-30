import { it, expect } from "vitest";
import { ProcessClient } from "../packages/protocol/src/client.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
it("runs a session through the shared RPC protocol and persists its history", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-rpc-"));
  const client = new ProcessClient(process.execPath, [
    "--import",
    "tsx",
    resolve("packages/cli/src/index.ts"),
    "--rpc",
    "--demo",
    "--home",
    home,
  ]);
  try {
    const events: any[] = [];
    client.subscribe((m) => events.push(m));
    const session = await client.request("session.create");
    expect(session.id).toBeTruthy();
    const result = await client.request("prompt", { text: "hello" });
    expect(result.accepted).toBe(true);
    const limit = Date.now() + 5000;
    while (
      !events.some((m) => m.type === "event" && m.event.type === "run.end")
    ) {
      if (Date.now() > limit) throw Error("Run did not settle");
      await new Promise((r) => setTimeout(r, 10));
    }
    const saved = await client.request("events.read", {
      sessionId: session.id,
    });
    expect(
      saved.some(
        (e: any) => e.type === "message" && e.data.message.text === "hello",
      ),
    ).toBe(true);
    expect((await client.request("session.list"))[0].title).toBe("hello");
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}, 10000);
