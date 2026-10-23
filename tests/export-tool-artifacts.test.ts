import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  readdir,
  symlink,
  truncate,
  open,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir, constants } from "node:os";
import { basename, join } from "node:path";
import { Runtime } from "../packages/runtime/src/index.ts";
import * as secureFiles from "../packages/tools/src/secure-files.ts";

const fixtures: Array<{ runtime: Runtime; cwd: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { runtime, cwd } of fixtures.splice(0)) {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hikaro-export-")));
  const home = join(cwd, "home");
  const runtime = await Runtime.open({
    cwd,
    home,
    demo: true,
    approve: async () => false,
  });
  fixtures.push({ runtime, cwd });
  const session = await runtime.session();
  const artifact = async (kind: "json" | "log", contents: string) => {
    const directory = join(
      home,
      kind === "json" ? "artifacts" : "outputs",
      session.id,
    );
    await mkdir(directory, { recursive: true });
    const name =
      kind === "json"
        ? createHash("sha256").update(randomUUID()).digest("hex")
        : randomUUID();
    const path = join(directory, `${name}.${kind}`);
    await writeFile(path, contents);
    return path;
  };
  const tool = (data: unknown, name = "test_tool") =>
    runtime.store.append(session.id, "tool.end", {
      callId: randomUUID(),
      name,
      result: { text: "Visible preview", data },
    });
  return { cwd, home, runtime, session, artifact, tool };
}

async function exported(runtime: Runtime, id: string) {
  const path = await runtime.exportSession(id);
  const text = await readFile(path, "utf8");
  const names = await readdir(path + ".assets").catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await readFile(join(path + ".assets", name)),
    })),
  );
  return { path, text, files };
}

it("exports only visible JSON fields and both known log references with portable links and byte digests", async () => {
  const { runtime, home, session, artifact, tool } = await fixture();
  const log = await artifact("log", "Full process output 中文 🌅\n");
  const secondLog = await artifact("log", "Other visible process output\n");
  const json = await artifact(
    "json",
    JSON.stringify({
      text: "Complete tool text beyond the message preview",
      isError: false,
      providerData: "PRIVATE-PROVIDER",
      unknown: "PRIVATE-TOP-LEVEL",
      data: { artifact: log, secret: "PRIVATE-INTERNAL" },
    }),
  );
  await tool({ artifact: json, process: { artifact: secondLog } });
  await tool({ artifact: log });
  await tool({ artifact: json });
  await runtime.store.append(session.id, "message", {
    message: {
      role: "assistant",
      text: "Visible transcript",
      thinking: "HIDDEN-THINKING",
      providerData: "PRIVATE-MESSAGE",
      timestamp: 1,
    },
  });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(3);
  expect(
    result.files
      .filter((file) => file.name.endsWith(".json"))
      .map((file) => JSON.parse(file.bytes.toString())),
  ).toEqual([
    { text: "Complete tool text beyond the message preview", isError: false },
  ]);
  expect(
    result.files.some((file) =>
      file.bytes.equals(Buffer.from("Full process output 中文 🌅\n")),
    ),
  ).toBe(true);
  expect(
    result.files.some((file) =>
      file.bytes.equals(Buffer.from("Other visible process output\n")),
    ),
  ).toBe(true);
  const all =
    result.text + result.files.map((file) => file.bytes.toString()).join();
  expect(all).not.toMatch(/PRIVATE-|HIDDEN-THINKING/);
  for (const file of result.files) {
    expect(result.text).toContain(
      createHash("sha256").update(file.bytes).digest("hex"),
    );
    expect(result.text).toContain(
      `${basename(result.path)}.assets/${file.name}`,
    );
  }
  await rm(join(home, "artifacts"), { recursive: true });
  await rm(join(home, "outputs"), { recursive: true });
  for (const file of result.files)
    expect(await readFile(join(result.path + ".assets", file.name))).toEqual(
      file.bytes,
    );
});

it("lists missing, rejected, malformed and oversized resources without leaking their bytes", async () => {
  const { runtime, cwd, session, artifact, tool } = await fixture();
  const missing = await artifact("log", "gone");
  await rm(missing);
  const outside = join(cwd, "outside.log");
  await writeFile(outside, "PRIVATE-OUTSIDE");
  const linked = await artifact("log", "replace");
  await rm(linked);
  await symlink(outside, linked);
  const invalid = await artifact(
    "json",
    JSON.stringify({ providerData: "PRIVATE-MALFORMED" }),
  );
  const huge = await artifact("log", "");
  await truncate(huge, 16 * 1024 * 1024 + 1);
  for (const path of [missing, outside, linked, invalid, huge])
    await tool({ artifact: path });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(0);
  expect(result.text).toMatch(/missing/i);
  expect(result.text).toMatch(/rejected/i);
  expect(result.text).toMatch(/invalid content/i);
  expect(result.text).toMatch(/16 MiB/i);
  expect(result.text).not.toContain("PRIVATE-");
});

it("rejects a symlink in an artifact parent directory and a different session", async () => {
  const { runtime, cwd, home, session, tool } = await fixture();
  const external = join(cwd, "elsewhere");
  await mkdir(external);
  const name = `${randomUUID()}.log`;
  await writeFile(join(external, name), "PRIVATE-PARENT");
  await mkdir(join(home, "outputs"));
  await symlink(external, join(home, "outputs", session.id));
  const other = await runtime.store.createSession(session.cwd);
  await mkdir(join(home, "outputs", other.id));
  const otherPath = join(home, "outputs", other.id, `${randomUUID()}.log`);
  await writeFile(otherPath, "PRIVATE-OTHER-SESSION");
  await tool({ artifact: join(home, "outputs", session.id, name) });
  await tool({ artifact: otherPath });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(0);
  expect(result.text.match(/rejected/gi)).toHaveLength(2);
  expect(result.text).not.toContain("PRIVATE-");
});

it("uses one event watermark for messages and tool artifacts", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  await tool({ artifact: await artifact("log", "Before watermark") });
  const original = runtime.store.latestSeq.bind(runtime.store);
  const latest = vi
    .spyOn(runtime.store, "latestSeq")
    .mockImplementationOnce(async (id) => {
      const through = await original(id);
      await tool({ artifact: await artifact("log", "AFTER-WATERMARK") });
      await runtime.store.append(id, "message", {
        message: { role: "assistant", text: "AFTER-WATERMARK", timestamp: 1 },
      });
      return through;
    });
  const result = await exported(runtime, session.id);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.bytes.toString()).toBe("Before watermark");
  expect(result.text).not.toContain("AFTER-WATERMARK");
});

it("continues past a full page with no references and deduplicates across pages", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  for (let index = 0; index < 101; index++) await tool(undefined);
  const path = await artifact("log", "After empty pages");
  await tool({ artifact: path });
  for (let index = 0; index < 101; index++) await tool(undefined);
  await tool({ artifact: path });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.bytes.toString()).toBe("After empty pages");
});

it("caps distinct candidates and explicitly lists the remainder without reading it", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  for (let index = 0; index < 101; index++)
    await tool({ artifact: await artifact("log", `Output ${index}`) });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(100);
  expect(
    result.files.some((file) => file.bytes.toString() === "Output 100"),
  ).toBe(false);
  expect(result.text).toMatch(/100.*candidate|candidate.*100/i);
});

it("does not recursively copy JSON dependencies or extract paths from tool text", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  const nested = await artifact(
    "json",
    JSON.stringify({ text: "NOT-A-DIRECT-DEPENDENCY" }),
  );
  const log = await artifact("log", "NOT-A-TEXT-REFERENCE");
  const top = await artifact(
    "json",
    JSON.stringify({
      text: `Visible path: ${log}`,
      data: { artifact: nested },
    }),
  );
  await tool({ artifact: top });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(1);
  expect(result.text).toMatch(/unsupported dependency/i);
  expect(result.files[0]!.bytes.toString()).not.toContain(
    "NOT-A-DIRECT-DEPENDENCY",
  );
  expect(result.files[0]!.bytes.toString()).not.toContain(
    "NOT-A-TEXT-REFERENCE",
  );
});

it("can export a direct JSON reference that was previously refused as a nested dependency", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  const nested = await artifact(
    "json",
    JSON.stringify({ text: "Direct result" }),
  );
  const top = await artifact(
    "json",
    JSON.stringify({ text: "Parent result", data: { artifact: nested } }),
  );
  await tool({ artifact: top });
  await tool({ artifact: nested });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(2);
  expect(
    result.files.map((file) => JSON.parse(file.bytes.toString()).text).sort(),
  ).toEqual(["Direct result", "Parent result"]);
});

it("aborts on a helper infrastructure failure and removes only the current staged export", async () => {
  const { runtime, home, session, artifact, tool } = await fixture();
  const previous = await exported(runtime, session.id);
  await tool({ artifact: await artifact("log", "First asset is staged") });
  await tool({ artifact: await artifact("log", "Second asset fails") });
  const original = secureFiles.readFileBytes;
  let reads = 0;
  vi.spyOn(secureFiles, "readFileBytes").mockImplementation(async (...args) => {
    if (++reads === 2)
      throw Error("Secure file helper unavailable: synthetic failure");
    return original(...args);
  });
  await expect(runtime.exportSession(session.id)).rejects.toThrow(
    /helper unavailable/,
  );
  expect(await readdir(join(home, "exports"))).toEqual([
    basename(previous.path),
  ]);
  expect(await readFile(previous.path, "utf8")).toBe(previous.text);
});

it("cleans staged assets after a filesystem output failure and preserves earlier exports", async () => {
  const { runtime, home, session, artifact, tool } = await fixture();
  const previous = await exported(runtime, session.id);
  await tool({ artifact: await artifact("log", "First asset") });
  await tool({ artifact: await artifact("log", "Second asset") });
  const original = secureFiles.readFileBytes;
  let reads = 0;
  vi.spyOn(secureFiles, "readFileBytes").mockImplementation(async (...args) => {
    const bytes = await original(...args);
    if (++reads === 2) {
      const assets = (await readdir(join(home, "exports"))).find((name) =>
        name.endsWith(".assets"),
      )!;
      await mkdir(join(home, "exports", assets, "tool-2.log"));
    }
    return bytes;
  });
  await expect(runtime.exportSession(session.id)).rejects.toThrow(
    /EEXIST|EISDIR/,
  );
  expect(await readdir(join(home, "exports"))).toEqual([
    basename(previous.path),
  ]);
  expect(await readFile(previous.path, "utf8")).toBe(previous.text);
});

it.each(["final inventory write", "final file close"] as const)(
  "does not publish when cancellation happens during %s",
  async (phase) => {
    const { runtime, cwd, home, session, artifact, tool } = await fixture();
    const previous = await exported(runtime, session.id);
    await tool({
      artifact: await artifact("log", "Staged before cancellation"),
    });
    const probe = await open(join(cwd, "handle-probe"), "w");
    const prototype = Object.getPrototypeOf(probe);
    const originalWrite = prototype.write;
    await probe.close();
    let cancelled = false;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      const result = await originalWrite.apply(this, args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith("- Resource 1: [tool-1.log]")
      ) {
        if (phase === "final inventory write") {
          cancelled = true;
          await runtime.close();
        } else {
          const close = this.close.bind(this);
          this.close = async () => {
            await close();
            if (!cancelled) {
              cancelled = true;
              await runtime.close();
            }
          };
        }
      }
      return result;
    });
    await expect(runtime.exportSession(session.id)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(await readdir(join(home, "exports"))).toEqual([
      basename(previous.path),
    ]);
    expect(await readFile(previous.path, "utf8")).toBe(previous.text);
  },
);

it("validates artifact paging and projects bounded references without private result fields", async () => {
  const { runtime, session, tool } = await fixture();
  const event = await tool(
    {
      artifact: "x".repeat(4097),
      process: { artifact: false },
      private: "PRIVATE-STORAGE",
    },
    "tool".repeat(100),
  );
  const page = await runtime.store.toolArtifactPage(session.id, {
    after: 0,
    through: event.seq,
  });
  expect(page.items[0]!.references).toEqual([
    { invalid: true },
    { invalid: true },
  ]);
  expect(page.items[0]!.name).toHaveLength(256);
  expect(JSON.stringify(page)).not.toContain("PRIVATE-STORAGE");
  for (const options of [
    { after: -1, through: event.seq },
    { after: 0.5, through: event.seq },
    { after: event.seq + 1, through: event.seq },
    { after: 0, through: event.seq, limit: 0 },
  ])
    await expect(
      runtime.store.toolArtifactPage(session.id, options),
    ).rejects.toThrow(/Invalid tool artifact range/);
});

it("rejects embedded-NUL references instead of shortening them into authorized files", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  const path = await artifact("log", "PRIVATE-NUL-TARGET");
  const event = await tool({ artifact: path + "\0" + "x".repeat(20000) });
  const page = await runtime.store.toolArtifactPage(session.id, {
    after: 0,
    through: event.seq,
  });
  expect(JSON.stringify(page).length).toBeLessThan(1024);
  expect(page.items[0]!.references).toEqual([{ invalid: true }]);
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(0);
  expect(result.text).toMatch(/rejected/i);
});

it("caps cumulative source bytes even when private JSON fields are excluded from export", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  const prefix = '{"text":"small visible text","private":"';
  const suffix = '"}';
  const source =
    prefix +
    "x".repeat(16 * 1024 * 1024 - prefix.length - suffix.length) +
    suffix;
  for (let index = 0; index < 4; index++)
    await tool({ artifact: await artifact("json", source) });
  await tool({ artifact: await artifact("log", "OVER-READ-BUDGET") });
  const result = await exported(runtime, session.id);
  expect(result.files).toHaveLength(4);
  expect(
    result.files.reduce((total, file) => total + file.bytes.length, 0),
  ).toBeLessThan(1024);
  expect(result.text).toMatch(/64 MiB.*read|read.*64 MiB/i);
  expect(
    result.files.some((file) => file.bytes.includes("OVER-READ-BUDGET")),
  ).toBe(false);
}, 15000);

it.each(["ESTALE", "EIO"] as const)(
  "charges the read allowance after %s so failed reads cannot exceed the budget",
  async (code) => {
    const { runtime, session, artifact, tool } = await fixture();
    for (let index = 0; index < 5; index++)
      await tool({
        artifact: await artifact("log", `Changing output ${index}`),
      });
    const read = vi
      .spyOn(secureFiles, "readFileBytes")
      .mockRejectedValue(
        new secureFiles.SecureFileError(
          "File changed after reading",
          constants.errno[code],
        ),
      );
    const result = await exported(runtime, session.id);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every((args) => args[2] === 16 * 1024 * 1024)).toBe(
      true,
    );
    expect(result.files).toHaveLength(0);
    expect(result.text.match(/Read failed/g)).toHaveLength(4);
    expect(result.text).toMatch(/64 MiB read\/output budget/);
  },
);

it("exports exactly 64 MiB of logs and marks additional resources as over budget", async () => {
  const { runtime, session, artifact, tool } = await fixture();
  const bytes = "x".repeat(16 * 1024 * 1024);
  for (let index = 0; index < 4; index++)
    await tool({ artifact: await artifact("log", bytes) });
  await tool({ artifact: await artifact("log", "OVER-OUTPUT-BUDGET") });
  const result = await exported(runtime, session.id);
  expect(
    result.files.reduce((total, file) => total + file.bytes.length, 0),
  ).toBe(64 * 1024 * 1024);
  expect(result.files).toHaveLength(4);
  expect(result.text).toMatch(/64 MiB.*budget|budget.*64 MiB/i);
}, 15000);
