import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import { libraryRequest } from "../apps/cli/src/rpc-library.ts";
import { publicEvent } from "../packages/protocol/src/index.ts";

it("pages large history and images without provider payloads, and only reads securely referenced session artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hikaro-library-"));
  const home = join(cwd, "home");
  const runtime = await Runtime.open({
    cwd,
    home,
    demo: true,
    approve: async () => false,
  });
  try {
    const session = await runtime.session();
    const selected = () => runtime.session(session.id);
    const invoke = (method: string, params: Record<string, unknown>) =>
      libraryRequest(runtime, method, params, selected) as Promise<any>;
    const text = "中文\n".repeat(100000);
    const image = Buffer.alloc(100000, 71).toString("base64");
    const event = await runtime.store.append(session.id, "message", {
      message: {
        role: "user",
        text,
        images: [{ mimeType: "image/png", data: image }],
        providerData: { secret: "signature" },
        timestamp: 1,
      },
    });
    const page = await runtime.store.messagePage(session.id, { bounded: true });
    const matches = await invoke("messages.search", {
      query: "中文",
      limit: 2,
    });
    expect(matches.items.map((item: { seq: number }) => item.seq)).toEqual([
      event.seq,
    ]);
    expect(JSON.stringify(matches)).not.toContain("signature");
    expect(matches.items[0].snippet.length).toBeLessThanOrEqual(240);
    expect(page.items[0]!.message.text).toHaveLength(20000);
    expect(JSON.stringify(page)).not.toContain(image);
    expect(JSON.stringify(publicEvent(event))).not.toContain("signature");
    expect(Buffer.byteLength(JSON.stringify(publicEvent(event)))).toBeLessThan(
      100000,
    );
    const content = await invoke("messages.content", {
      seq: event.seq,
      offset: 20000,
      limit: 37,
    });
    expect(content.data).toBe(text.slice(20000, 20037));
    expect(content.nextOffset).toBe(20037);
    const pixels = await invoke("messages.content", {
      seq: event.seq,
      field: "image",
      offset: 12,
      limit: 16,
    });
    expect(pixels).toMatchObject({
      data: image.slice(12, 28),
      encoding: "base64",
      total: image.length,
      mimeType: "image/png",
    });
    let exported = "",
      after = 0,
      offset = 0,
      through: number | undefined;
    for (let i = 0; i < 30; i++) {
      const part = await invoke("session.export", {
        after,
        offset,
        ...(through === undefined ? {} : { through }),
      });
      through = part.through;
      exported += part.text;
      if (!part.hasMore) break;
      after = part.after;
      offset = part.nextOffset ?? 0;
    }
    expect(exported).toBe(`## user\n\n${text}\n\n`);
    const folder = join(home, "artifacts", session.id),
      path = join(folder, "a".repeat(64) + ".json");
    await mkdir(folder, { recursive: true });
    await writeFile(path, "safe contents");
    const tool = await runtime.store.append(session.id, "tool.end", {
      result: { text: "preview", data: { artifact: path } },
    });
    const artifact = await invoke("artifact.read", { seq: tool.seq, limit: 4 });
    expect(Buffer.from(artifact.data, "base64").toString()).toBe("safe");
    await expect(
      invoke("artifact.read", { seq: tool.seq, digest: "changed" }),
    ).rejects.toThrow(/changed/i);
    await rm(path);
    await symlink(join(cwd, "private"), path);
    await writeFile(join(cwd, "private"), "never expose");
    await expect(invoke("artifact.read", { seq: tool.seq })).rejects.toThrow();
    await expect(
      invoke("model.set", {
        provider: "demo",
        model: "offline",
        baseUrl: "https://untrusted.example",
      }),
    ).rejects.toThrow(/host/);
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 10000);
