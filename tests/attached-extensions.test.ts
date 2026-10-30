import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSharedHost } from "../packages/cli/src/shared-host.ts";
import { SharedHostClient } from "../packages/host/src/client.ts";

it("runs local extensions and manual tools, exports results and refuses Plan side effects", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-extensions-")),
  );
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(
    join(home, "plugin.mjs"),
    `export default {id:'proof',apiVersion:1,setup(api){api.registerCommand('proof',async args=>'command:'+args);api.registerView('proof-view',async()=>'view:ready')}}`,
  );
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: [{ path: "plugin.mjs", trusted: true }] }),
  );
  let host = await serveSharedHost({
    home,
    cwd,
    demo: true,
    trusted: true,
    permissionMode: "full",
  });
  let client = await SharedHostClient.connect({
    home,
    cwd,
    clientId: "extensions",
  });
  try {
    await client.request("hello");
    const session = await client.request("session.create");
    expect((await client.request("plugins.list")).items).toContainEqual({
      name: "proof",
      kind: "command",
    });
    expect(
      await client.request("plugins.invoke", { name: "proof", args: "hello" }),
    ).toMatchObject({ text: "command:hello" });
    expect(
      await client.request("plugins.invoke", {
        name: "proof-view",
        kind: "view",
      }),
    ).toMatchObject({ text: "view:ready" });
    await client.request("tool.manual", {
      command: "printf manual-proof",
      unrestricted: true,
    });
    const running = client.request("tool.manual", {
      command: "sleep 20",
      unrestricted: true,
    });
    await vi.waitFor(async () =>
      expect((await client.request("session.current")).busy).toBe(true),
    );
    expect(
      await client.request("execution.read", { kind: "terminals" }),
    ).toEqual([]);
    await client.request("cancel");
    await running;
    expect((await client.request("session.current")).busy).toBe(false);
    const exported = await client.request("session.export.file", {
      includeThinking: false,
    });
    expect(await readFile(exported.path, "utf8")).toContain("manual-proof");
    const params = { command: "printf once >> once.txt", unrestricted: true };
    await client.request("tool.manual", params, false, { id: "manual-once" });
    expect(
      await client.request("tool.manual", params, false, { id: "manual-once" }),
    ).toMatchObject({ duplicate: true });
    await client.close();
    await host.close();
    host = await serveSharedHost({
      home,
      cwd,
      demo: true,
      trusted: true,
      permissionMode: "full",
    });
    client = await SharedHostClient.connect({
      home,
      cwd,
      clientId: "extensions",
    });
    await client.request("hello");
    await client.request("session.resume", { sessionId: session.id });
    expect(
      await client.request("tool.manual", params, false, { id: "manual-once" }),
    ).toMatchObject({ duplicate: true });
    expect(await readFile(join(cwd, "once.txt"), "utf8")).toBe("once");
    const recovered = await client.request("session.export.file");
    expect(await readFile(recovered.path, "utf8")).toContain("command:hello");
    expect(await readFile(recovered.path, "utf8")).toContain("view:ready");
    await client.request("plan.set", { active: true });
    await expect(
      client.request("plugins.invoke", { name: "proof" }),
    ).rejects.toThrow(/Plan/);
    await client
      .request("tool.manual", { command: "touch forbidden" })
      .catch(() => {});
    await expect(readFile(join(cwd, "forbidden"))).rejects.toThrow();
    expect((await client.request("session.current")).session.id).toBe(
      session.id,
    );
  } finally {
    await client.close();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
