import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", { spy: true });
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, ToolRegistry } from "../packages/core/src/index.ts";
import type { ToolContext } from "../packages/core/src/types.ts";
import { codingPlugin } from "../packages/tools/src/index.ts";
import {
  indexPlugin,
  type Chunk,
  type IndexStore,
} from "../packages/tools/src/indexer.ts";
import { createHash } from "node:crypto";

const folders: string[] = [];
const run = promisify(execFile);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});

async function fixture() {
  const home = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "hikaro-path-race-")),
  );
  folders.push(home);
  const cwd = join(home, "workspace");
  const parent = join(cwd, "nested");
  const outside = join(home, "outside");
  const detached = join(home, "detached");
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(parent, "source.txt"), "original");
  await fs.writeFile(join(outside, "source.txt"), "OUTSIDE_PRIVATE_CONTENT");
  const tools = new ToolRegistry();
  await new PluginHost(tools).load(
    codingPlugin({ trusted: false, reviewReads: () => true }),
  );
  const context: ToolContext = {
    cwd,
    sessionId: "path-race",
    signal: AbortSignal.timeout(10000),
    callId: "path-race",
    depth: 0,
    budget: {
      usage: { input: 0, output: 0, cost: 0 },
      maxCost: 1,
      modelCallsLeft: 1,
    },
    approve: vi.fn(async () => true),
    invoke: async () => {
      throw Error("Unexpected nested tool invocation");
    },
    emit: async () => {},
  };
  const invoke = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    return tool.execute(tool.schema.parse(args), context);
  };
  const swap = async () => {
    // Run the attacker in a separate process; it does not share Hikaro's locks.
    await run(process.execPath, [
      "--input-type=module",
      "-e",
      `import { rename, symlink } from 'node:fs/promises';
       await rename(process.argv[1], process.argv[2]);
       await symlink(process.argv[3], process.argv[1], 'dir');`,
      parent,
      detached,
      outside,
    ]);
  };
  const assertOutsideUntouched = async () => {
    expect(await fs.readFile(join(outside, "source.txt"), "utf8")).toBe(
      "OUTSIDE_PRIVATE_CONTENT",
    );
    expect(await fs.readdir(outside)).toEqual(["source.txt"]);
    expect(await fs.readdir(detached)).toEqual(["source.txt"]);
  };
  return {
    cwd,
    parent,
    outside,
    detached,
    context,
    tools,
    invoke,
    swap,
    assertOutsideUntouched,
  };
}

const updates = [
  {
    name: "replacement",
    tool: "write_file",
    args: {
      path: "nested/source.txt",
      expected: "OUTSIDE_PRIVATE_CONTENT",
      content: "escaped write",
    },
  },
  {
    name: "creation",
    tool: "write_file",
    args: { path: "nested/created.txt", content: "escaped create" },
  },
  {
    name: "edit",
    tool: "edit_file",
    args: {
      path: "nested/source.txt",
      oldText: "OUTSIDE_PRIVATE_CONTENT",
      newText: "escaped edit",
    },
  },
];

it.each(updates)(
  "$tool $name cannot follow a parent replaced while its resolved path awaits approval",
  async ({ tool, args }) => {
    const { context, invoke, swap, assertOutsideUntouched } = await fixture();
    context.approve = async () => {
      await swap();
      return true;
    };
    await invoke(tool, args).catch(() => undefined);
    await assertOutsideUntouched();
  },
);

it("read_file cannot return outside content when a parent changes while its resolved path awaits approval", async () => {
  const { context, invoke, swap, assertOutsideUntouched } = await fixture();
  context.approve = async () => {
    await swap();
    return true;
  };
  const result = await invoke("read_file", { path: "nested/source.txt" }).catch(
    () => undefined,
  );
  expect(result?.text ?? "").not.toContain("OUTSIDE_PRIVATE_CONTENT");
  await assertOutsideUntouched();
});

it("search scans only bytes from the authorized file after a directory replacement", async () => {
  const { context, invoke, swap, assertOutsideUntouched } = await fixture();
  context.approve = async () => {
    await swap();
    return true;
  };
  const result = await invoke("search", {
    pattern: "OUTSIDE_PRIVATE_CONTENT",
    glob: "nested/source.txt",
  }).catch(() => undefined);
  expect(result?.text ?? "").not.toContain("OUTSIDE_PRIVATE_CONTENT");
  await assertOutsideUntouched();
});

it.each(["index_codebase", "semantic_search"])(
  "%s cannot read through a directory replaced after canonical resolution",
  async (name) => {
    const {
      cwd,
      parent,
      tools,
      context,
      invoke,
      swap,
      assertOutsideUntouched,
    } = await fixture();
    const secret = "OUTSIDE_PRIVATE_CONTENT";
    const saved: Chunk[] = [];
    const store: IndexStore = {
      indexReplace: async (_workspace, _path, chunks) => {
        saved.push(...chunks);
      },
      indexFiles: async () => [],
      indexPrune: async () => {},
      indexSearch: async () => [
        {
          id: "cached",
          workspace: cwd,
          path: "nested/source.txt",
          line: 1,
          text: secret,
          hash: createHash("sha256").update(secret).digest("hex"),
        },
      ],
    };
    await new PluginHost(tools).load(indexPlugin(store));
    const { realpath: original } =
      await vi.importActual<typeof fs>("node:fs/promises");
    let swapped = false;
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const actual = await original(...args);
      if (!swapped && String(args[0]) === join(parent, "source.txt")) {
        swapped = true;
        await swap();
      }
      return actual;
    });
    try {
      const result = await invoke(
        name,
        name === "semantic_search" ? { query: secret } : {},
      ).catch(() => undefined);
      expect(result?.text ?? "").not.toContain(secret);
      expect(saved.some((chunk) => chunk.text.includes(secret))).toBe(false);
      expect(swapped).toBe(true);
      await assertOutsideUntouched();
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(["write_file", "edit_file"])(
  "%s cleans its original lock and temporary file after a parent replacement during commit",
  async (tool) => {
    const { context, invoke, swap, assertOutsideUntouched } = await fixture();
    context.checkpoint = swap;
    const args =
      tool === "write_file"
        ? {
            path: "nested/source.txt",
            expected: "original",
            content: "changed",
          }
        : {
            path: "nested/source.txt",
            oldText: "original",
            newText: "changed",
          };
    await invoke(tool, args).catch(() => undefined);
    await assertOutsideUntouched();
  },
);

it("still reads, creates, replaces and edits ordinary workspace files", async () => {
  const { parent, invoke, outside } = await fixture();
  expect(
    (await invoke("read_file", { path: "nested/source.txt" })).text,
  ).toContain("1: original");
  await invoke("write_file", {
    path: "nested/new/deep.txt",
    content: "created",
  });
  await invoke("write_file", {
    path: "nested/source.txt",
    expected: "original",
    content: "replaced",
  });
  await invoke("edit_file", {
    path: "nested/source.txt",
    oldText: "replaced",
    newText: "edited",
  });
  expect(await fs.readFile(join(parent, "source.txt"), "utf8")).toBe("edited");
  expect(await fs.readFile(join(parent, "new/deep.txt"), "utf8")).toBe(
    "created",
  );
  expect((await fs.readdir(parent)).sort()).toEqual(["new", "source.txt"]);
  expect(await fs.readdir(join(parent, "new"))).toEqual(["deep.txt"]);
  expect(await fs.readdir(outside)).toEqual(["source.txt"]);
});
