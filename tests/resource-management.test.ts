import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/runtime/src/index.ts";
import * as tools from "../packages/tools/src/index.ts";

const runtimes: Runtime[] = [],
  folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "hikaro-resources-")),
  );
  folders.push(home);
  const cwd = join(home, "work");
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "initial instructions");
  const runtime = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  runtimes.push(runtime);
  return { home, cwd, runtime };
}

it("registers explicitly trusted local skills and reloads existing Agents without resetting their budget", async () => {
  const { home, cwd, runtime } = await fixture();
  const session = await runtime.session(),
    agent = await runtime.agent(session);
  const budget = agent.budget;
  budget.usage.cost = 9;
  budget.modelCallsLeft = 7;
  const source = join(home, "local-resource-proof");
  await mkdir(source);
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: local-resource-proof\ndescription: Local registered skill\n---\nRead supporting.txt.\n",
  );
  await writeFile(join(source, "supporting.txt"), "relative resource");
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ retained: { value: 1 } }),
  );
  await expect(
    runtime.installResource({ kind: "skill", path: source, trusted: false }),
  ).rejects.toThrow(/trusted/);
  await runtime.installResource({ kind: "skill", path: source, trusted: true });
  expect(
    runtime.resources.skills.some(
      (skill) => skill.name === "local-resource-proof",
    ),
  ).toBe(false);
  await writeFile(join(cwd, "AGENTS.md"), "reloaded instructions");
  await runtime.reloadResources();
  expect(await runtime.agent(session)).toBe(agent);
  expect(agent.budget).toBe(budget);
  expect(agent.budget.modelCallsLeft).toBe(7);
  expect(agent.usage.cost).toBe(9);
  expect(agent.options.system).toContain("reloaded instructions");
  expect(agent.options.system).not.toContain("initial instructions");
  expect(agent.options.readonlyResources).toContain(join(source, "SKILL.md"));
  expect(
    JSON.parse(await readFile(join(home, "config.json"), "utf8")),
  ).toMatchObject({
    retained: { value: 1 },
    resources: { skills: [{ path: source, trusted: true }] },
  });
  await runtime.close();
  const reopened = await Runtime.open({
    home,
    cwd,
    demo: true,
    approve: async () => false,
  });
  runtimes.push(reopened);
  expect(
    reopened.resources.skills.some(
      (skill) => skill.path === join(source, "SKILL.md"),
    ),
  ).toBe(true);
});

it("registers a trusted plugin for restart without importing it in the current host", async () => {
  const { home, runtime } = await fixture();
  const path = join(home, "plugin.mjs");
  await writeFile(
    path,
    'throw new Error("plugin imported during installation");',
  );
  expect(
    await runtime.installResource({ kind: "plugin", path, trusted: true }),
  ).toMatchObject({ restartRequired: true, path });
  expect(
    JSON.parse(await readFile(join(home, "config.json"), "utf8")),
  ).toMatchObject({ plugins: [{ path, trusted: true }] });
});

it("refuses resource reload while messages are queued and rechecks before publishing async loads", async () => {
  const { cwd, runtime } = await fixture();
  const agent = await runtime.agent(await runtime.session());
  const original = agent.options.system;
  const releaseQueue = agent.holdQueue();
  await agent.enqueuePrompt("queued");
  await expect(runtime.reloadResources()).rejects.toThrow(/queued|running/);
  agent.cancel(true);
  releaseQueue();
  await agent.queueSettled();
  let entered!: () => void, resume!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const load = tools.loadInstructions;
  vi.spyOn(tools, "loadInstructions").mockImplementationOnce(
    async (...args) => {
      entered();
      await blocked;
      return load(...args);
    },
  );
  await writeFile(
    join(cwd, "AGENTS.md"),
    "must not publish during a queued prompt",
  );
  const reload = runtime.reloadResources();
  const rejected = expect(reload).rejects.toThrow(/queued|running/);
  await began;
  const releaseNext = agent.holdQueue();
  await agent.enqueuePrompt("queued during reload");
  resume();
  await rejected;
  expect(agent.options.system).toBe(original);
  agent.cancel(true);
  releaseNext();
});
