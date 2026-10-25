import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  attachmentReference,
  parseFileReferences,
  preparePrompt,
  validateImageInputs,
} from "../packages/runtime/src/attachments.ts";
import { Runtime } from "../packages/runtime/src/index.ts";
import { SQLiteStore } from "../packages/storage/src/index.ts";
import { Agent, ToolRegistry } from "../packages/core/src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=",
  "base64",
);
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-attachments-")),
  );
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return {
    root,
    cwd,
    signal: AbortSignal.timeout(5000),
    supportsImages: true,
    approve: vi.fn(async () => false),
  };
}

it("parses only explicit references, including quoted and terminal-escaped paths", () => {
  expect(
    parseFileReferences(
      "Review @README.md @\"my file.ts\" @'中文 文档.md' @a\\ b.png user@example.com @@literal `@code`\n```\n@hidden\n```\n@~/shot.png",
    ),
  ).toEqual([
    "README.md",
    "my file.ts",
    "中文 文档.md",
    "a b.png",
    "~/shot.png",
  ]);
  expect(() => parseFileReferences('@"unfinished')).toThrow(/quote/i);
  expect(() => parseFileReferences(Array(9).fill("@a").join(" "))).toThrow(/8/);
  expect(parseFileReferences("~~~txt\n@ignored\n~~~\n@read")).toEqual(["read"]);
  expect(parseFileReferences("```js\n@ignored\n````\n@read")).toEqual(["read"]);
  expect(parseFileReferences("~~~\n@ignored\n~~~~\n@read")).toEqual(["read"]);
  expect(attachmentReference("my screenshot.png")).toBe('@"my screenshot.png"');
  expect(attachmentReference("'my screenshot.png'")).toBe(
    '@"my screenshot.png"',
  );
  expect(attachmentReference("my\\ screenshot.png")).toBe(
    '@"my screenshot.png"',
  );
});

it("loads exact UTF-8 once per canonical path, without interpreting nested file references", async () => {
  const input = await fixture();
  await writeFile(join(input.cwd, "code.ts"), "const 中文 = '🙂';\n@secret\n");
  await symlink(join(input.cwd, "code.ts"), join(input.cwd, "alias.ts"));
  const result = await preparePrompt("Review @code.ts @alias.ts", input);
  const records = JSON.parse(result.text.split("\nATTACHMENTS_JSON\n")[1]!);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    path: "code.ts",
    content: "const 中文 = '🙂';\n@secret\n",
    kind: "text",
  });
  expect(records[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.images).toBeUndefined();
  expect(input.approve).not.toHaveBeenCalled();
});

it("requires permission for external symlink targets and sensitive aliases before reading", async () => {
  const input = await fixture();
  await writeFile(join(input.root, "outside.txt"), "outside");
  await symlink(join(input.root, "outside.txt"), join(input.cwd, "link.txt"));
  await expect(preparePrompt("@link.txt", input)).rejects.toThrow(
    /Permission denied/,
  );
  expect(input.approve).toHaveBeenCalledWith(
    expect.objectContaining({ path: join(input.root, "outside.txt") }),
  );
  await writeFile(join(input.cwd, "plain"), "sensitive alias");
  await symlink(join(input.cwd, "plain"), join(input.cwd, ".env"));
  input.approve.mockResolvedValue(true);
  await expect(preparePrompt("@.env", input)).resolves.toMatchObject({
    text: expect.stringContaining("sensitive alias"),
  });
  expect(input.approve).toHaveBeenCalledTimes(2);
});

it("detects images by bytes, attaches exact bytes, and rejects known text-only models", async () => {
  const input = await fixture();
  await writeFile(join(input.cwd, "screenshot.bin"), png);
  const result = await preparePrompt("Explain @screenshot.bin", input);
  expect(result.images).toEqual([
    { mimeType: "image/png", data: png.toString("base64") },
  ]);
  expect(result.text).toContain('"imageIndex":1');
  await expect(
    preparePrompt("@screenshot.bin", { ...input, supportsImages: false }),
  ).rejects.toThrow(/does not support images/);
});

it.each([
  ["bad.png", Buffer.from("not an image"), /image/i],
  ["huge.txt", Buffer.alloc(128 * 1024 + 1, 65), /128 KiB/],
])("refuses %s without silent truncation", async (name, bytes, error) => {
  const input = await fixture();
  await writeFile(join(input.cwd, name), bytes);
  await expect(preparePrompt(`@${name}`, input)).rejects.toThrow(error);
});

it("keeps non-text inputs as archival files instead of coercing them into model text", async () => {
  const input = await fixture();
  await writeFile(join(input.cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(input.cwd, "broken.txt"), Buffer.from([0xff]));
  const prepared = await preparePrompt("@binary.dat @broken.txt", input);
  expect(prepared.files?.map((file) => file.data)).toEqual(["AAEC", "/w=="]);
  expect(prepared.text).not.toContain("AAEC");
  expect(prepared.text).not.toContain("/w==");
});

it("rejects combined text overflow and cancellation after approval", async () => {
  const input = await fixture();
  await Promise.all(
    ["a", "b", "c"].map((file) =>
      writeFile(join(input.cwd, file), "x".repeat(100_000)),
    ),
  );
  await expect(preparePrompt("@a @b @c", input)).rejects.toThrow(/256 KiB/);
  await writeFile(join(input.root, "out"), "private");
  const controller = new AbortController();
  await expect(
    preparePrompt("@../out", {
      ...input,
      signal: controller.signal,
      approve: async () => {
        controller.abort();
        return true;
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("validates RPC image content and base64 before accepting it", () => {
  const data = png.toString("base64");
  expect(validateImageInputs([{ mimeType: "image/png", data }])).toEqual([
    { mimeType: "image/png", data },
  ]);
  expect(() => validateImageInputs([{ mimeType: "image/jpeg", data }])).toThrow(
    /match/i,
  );
  expect(() =>
    validateImageInputs([{ mimeType: "image/png", data: "$$$$" }]),
  ).toThrow(/base64/i);
  expect(() =>
    validateImageInputs([
      { mimeType: "image/png", data: png.subarray(0, 20).toString("base64") },
    ]),
  ).toThrow(/image/i);
});

it("rejects combined image overflow and serialized prompt overflow before dispatch", async () => {
  const bytes = Buffer.alloc(2_200_000);
  bytes.set([0xff, 0xd8, 0xff]);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  const image = { mimeType: "image/jpeg", data: bytes.toString("base64") };
  expect(() => validateImageInputs([image, image])).toThrow(/combined 4 MiB/);
  const input = await fixture();
  await expect(
    preparePrompt("x".repeat(8 * 1024 * 1024), input),
  ).rejects.toThrow(/stored-message limit/);
});

it("does not auto-approve sensitive aliases whose canonical target looks harmless", async () => {
  const input = await fixture();
  await writeFile(join(input.cwd, "plain"), "private");
  await symlink(join(input.cwd, "plain"), join(input.cwd, ".env"));
  const runtime = await Runtime.open({
    cwd: input.cwd,
    home: join(input.root, "home"),
    demo: true,
    permissionMode: "auto",
    approve: input.approve,
  });
  try {
    const session = await runtime.session();
    await expect(runtime.preparePrompt(session, "@.env")).rejects.toThrow(
      /Permission denied/,
    );
    expect(input.approve).toHaveBeenCalledOnce();
    expect(await runtime.store.messages(session.id)).toHaveLength(0);
  } finally {
    await runtime.close();
  }
});

it("preserves text and image snapshots for replay after the source files are removed", async () => {
  const input = await fixture();
  const code = join(input.cwd, "code.ts");
  const shot = join(input.cwd, "shot.png");
  await writeFile(code, "const answer = 42;");
  await writeFile(shot, png);
  const prepared = await preparePrompt("Review @code.ts @shot.png", input);
  const database = join(input.root, "session.sqlite");
  const store = await SQLiteStore.open(database);
  const session = await store.createSession(input.cwd);
  try {
    const agent = new Agent({
      session,
      store,
      tools: new ToolRegistry(),
      approve: async () => false,
      provider: {
        id: "fixture",
        model: "vision",
        contextWindow: 64000,
        supportsImages: true,
        async *stream(request) {
          expect(request.messages.at(-1)?.images?.[0]?.data).toBe(
            png.toString("base64"),
          );
          yield {
            type: "done",
            message: { role: "assistant", text: "Reviewed", timestamp: 1 },
            usage: { input: 1, output: 1, cost: 0 },
          };
        },
      },
    });
    await agent.prompt(prepared.text, prepared.images);
  } finally {
    await store.close();
  }
  await Promise.all([rm(code), rm(shot)]);
  const reopened = await SQLiteStore.open(database);
  try {
    const [message] = await reopened.messages(session.id);
    expect(message?.text).toContain("const answer = 42;");
    expect(message?.images?.[0]?.data).toBe(png.toString("base64"));
  } finally {
    await reopened.close();
  }
});
