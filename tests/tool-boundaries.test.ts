import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/runtime/src/index.ts";
import { canAutoApprove } from "../packages/runtime/src/permissions.ts";

const runtimes: Runtime[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const path of folders.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(mode: "ask" | "auto", index = false) {
  const home = await mkdtemp(join(tmpdir(), "hikaro-boundary-"));
  folders.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  if (index)
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ index: { enabled: true } }),
    );
  const approve = vi.fn(async () => false);
  const runtime = await Runtime.open({
    cwd,
    home,
    demo: true,
    permissionMode: mode,
    approve,
  });
  runtimes.push(runtime);
  const agent = await runtime.agent(await runtime.session());
  const invoke = (name: string, args: Record<string, unknown>) =>
    agent.invoke(name, args, AbortSignal.timeout(15000));
  return { runtime, cwd, home, approve, invoke };
}

it("requires approval for Git control files and never executes a configured fsmonitor", async () => {
  const { cwd, home, approve, invoke } = await fixture("ask");
  execFileSync("git", ["init", "-q", cwd]);
  const marker = join(home, "escaped");
  const config = join(cwd, ".git/config");
  const original = await readFile(config, "utf8");
  const malicious = original + `\n[core]\n\tfsmonitor = touch '${marker}'\n`;
  expect(
    (
      await invoke("write_file", {
        path: ".git/config",
        content: malicious,
        expected: original,
      })
    ).isError,
  ).toBe(true);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(await readFile(config, "utf8")).toBe(original);
  // Preexisting configuration must also be safe; file-write checks alone are insufficient.
  await writeFile(config, malicious);
  const status = await invoke("git_status", {});
  if (process.platform === "darwin") expect(status.isError).toBe(false);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

it.each([".env", "credentials.json", "nested/.env.local", "alias.txt"])(
  "search cannot bypass denied reads of %s",
  async (path) => {
    const { cwd, approve, invoke } = await fixture("auto");
    await mkdir(join(cwd, "nested"));
    const target = path === "alias.txt" ? ".env" : path;
    await writeFile(join(cwd, target), "BOUNDARY_FAKE_SECRET");
    if (path === "alias.txt") await symlink(join(cwd, target), join(cwd, path));
    expect((await invoke("read_file", { path })).isError).toBe(true);
    const result = await invoke("search", {
      pattern: "BOUNDARY_FAKE_SECRET",
      glob: path,
    });
    expect(result.text).not.toContain("BOUNDARY_FAKE_SECRET");
    expect(approve).toHaveBeenCalled();
  },
);

it("does not silently approve shell scans or Git diffs that can read sensitive files", async () => {
  const { cwd, approve, invoke } = await fixture("auto");
  const request = {
    id: "scan",
    sessionId: "test",
    tool: "shell",
    reason: "scan",
    arguments: { command: "rg -n VALUE ." },
  };
  expect(await canAutoApprove(request, cwd)).toBe(false);
  expect((await invoke("git_diff", {})).isError).toBe(true);
  expect(approve).toHaveBeenCalledTimes(1);
});

it("requires resource review before Git status can run a clean filter in auto mode", async () => {
  const { cwd, approve, invoke } = await fixture("auto");
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(join(cwd, "source.txt"), "baseline\n");
  execFileSync("git", ["-C", cwd, "add", "source.txt"]);
  await writeFile(join(cwd, ".env"), "FILTER_FAKE_SECRET");
  await writeFile(join(cwd, ".gitattributes"), "source.txt filter=leak\n");
  execFileSync("git", [
    "-C",
    cwd,
    "config",
    "filter.leak.clean",
    'sh -c "cat .env >&2; cat"',
  ]);
  await writeFile(join(cwd, "source.txt"), "modified\n");
  const result = await invoke("git_status", {});
  expect(result.isError).toBe(true);
  expect(result.text).not.toContain("FILTER_FAKE_SECRET");
  expect(approve).toHaveBeenCalledTimes(1);
});

it("search applies approval to the actual resource and still searches normal files", async () => {
  const { cwd, approve, invoke } = await fixture("auto");
  await writeFile(join(cwd, "source.ts"), "NORMAL_MATCH");
  expect((await invoke("search", { pattern: "NORMAL_MATCH" })).text).toContain(
    "NORMAL_MATCH",
  );
  expect(approve).not.toHaveBeenCalled();
  await writeFile(join(cwd, ".env"), "APPROVED_MATCH");
  approve.mockResolvedValue(true);
  expect(
    (await invoke("search", { pattern: "APPROVED_MATCH", glob: ".env" })).text,
  ).toContain("APPROVED_MATCH");
  expect(approve).toHaveBeenCalledTimes(1);
});

it("indexing and cached search exclude sensitive resources and path aliases", async () => {
  const { cwd, runtime, invoke } = await fixture("auto", true);
  const text = "INDEX_FAKE_SECRET";
  await writeFile(join(cwd, "credentials.json"), text);
  await writeFile(join(cwd, "ordinary.ts"), "SAFE_INDEX_MATCH");
  await invoke("index_codebase", {});
  expect((await invoke("semantic_search", { query: text })).text).not.toContain(
    text,
  );
  // A cache populated under an earlier policy must not bypass current authorization.
  const { createHash } = await import("node:crypto");
  await runtime.store.indexReplace(cwd, "credentials.json", [
    {
      id: "old",
      workspace: cwd,
      path: "credentials.json",
      line: 1,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
    },
  ]);
  expect((await invoke("semantic_search", { query: text })).text).not.toContain(
    text,
  );
});
