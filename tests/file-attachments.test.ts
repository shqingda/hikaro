import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import { preparePrompt } from "../packages/runtime/src/attachments.ts";
import { publicMessage } from "../packages/protocol/src/index.ts";
import { fitContext } from "../packages/core/src/context.ts";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

it("saves generic bytes with the user turn, excludes them from model/UI payloads, and exports a portable copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-files-"));
  homes.push(home);
  const path = join(home, "document.bin"),
    bytes = Buffer.from([0, 255, 128, 1, 2]);
  await writeFile(path, bytes);
  const input = await preparePrompt("Keep @document.bin", {
    cwd: home,
    signal: new AbortController().signal,
    approve: async () => false,
  });
  expect(input.files).toHaveLength(1);
  expect(input.text).toContain("not sent to the model");
  expect(input.text).not.toContain(bytes.toString("base64"));
  const runtime = await Runtime.open({
    home,
    cwd: home,
    demo: true,
    approve: async () => false,
  });
  try {
    const session = await runtime.session(),
      agent = await runtime.agent(session);
    await agent.prompt(input.text, input.images, undefined, input.files);
    const message = (await runtime.store.messages(session.id))[0]!;
    expect(message.files?.[0]?.data).toBe(bytes.toString("base64"));
    expect(publicMessage(message)).toMatchObject({ fileCount: 1 });
    expect(JSON.stringify(publicMessage(message))).not.toContain(
      bytes.toString("base64"),
    );
    expect(fitContext([message], 32000).messages[0]?.files).toBeUndefined();
    expect(
      JSON.stringify(await runtime.store.contextHistory(session.id)),
    ).not.toContain(bytes.toString("base64"));
    const exported = await runtime.exportSession(session.id),
      assets = exported + ".assets";
    const names = await readdir(assets);
    expect(names).toHaveLength(1);
    expect(await readFile(join(assets, names[0]!))).toEqual(bytes);
    expect(await readFile(exported, "utf8")).toContain(
      "application/octet-stream",
    );
    await runtime.store.append(session.id, "message", {
      message: {
        role: "user",
        text: "damaged slot",
        timestamp: 2,
        files: [{ name: "lost.bin" }],
      },
    });
    expect(
      await readFile(await runtime.exportSession(session.id), "utf8"),
    ).toContain("File 1 unavailable");
  } finally {
    await runtime.close();
  }
});
