import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ProviderCatalog,
  readModelDefault,
} from "../packages/provider-pi/src/catalog.ts";
import { createPiProvider } from "../packages/provider-pi/src/index.ts";
import { Runtime } from "../packages/runtime/src/index.ts";
import { libraryRequest } from "../apps/cli/src/rpc-library.ts";
import type { ModelSelection } from "../packages/core/src/types.ts";

const homes: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const value = await mkdtemp(join(tmpdir(), "hikaro-capabilities-"));
  homes.push(value);
  return value;
}
const selection: ModelSelection = {
  provider: "openai",
  model: "gpt-6.1-sol",
  baseUrl: "http://localhost:11434/v1",
  settings: {},
  endpointCapabilities: {
    contextWindow: 64000,
    maxOutputTokens: 2048,
    images: false,
    reasoning: ["off", "high"],
  },
};

it("uses endpoint declarations instead of a same-named built-in model for UI and validation", async () => {
  const catalog = new ProviderCatalog(
    await home(),
    new InMemoryCredentialStore(),
  );
  expect(await catalog.capabilities(selection)).toMatchObject({
    source: "endpoint",
    unknown: [],
    contextWindow: 64000,
    maxOutputTokens: 2048,
    images: false,
    reasoning: ["off", "high"],
    speed: ["default"],
  });
  const provider = await createPiProvider({
    ...selection,
    settings: { reasoning: "high", contextWindow: 48000 },
  });
  expect(provider).toMatchObject({
    contextWindow: 48000,
    maxOutputTokens: 2048,
    supportsImages: false,
  });
  await expect(
    createPiProvider({ ...selection, settings: { reasoning: "low" } }),
  ).rejects.toThrow(/reasoning/);
  await expect(
    createPiProvider({ ...selection, settings: { contextWindow: 64001 } }),
  ).rejects.toThrow(/Context/);
  await expect(
    createPiProvider({ ...selection, settings: { speed: "priority" } }),
  ).rejects.toThrow(/speed/);
});

it("keeps legacy endpoint configurations readable and labels undeclared capabilities unknown", async () => {
  const directory = await home();
  const { endpointCapabilities: _, ...legacy } = selection;
  await writeFile(
    join(directory, "model-selection.json"),
    JSON.stringify(legacy),
  );
  expect(await readModelDefault(directory)).toEqual(legacy);
  const catalog = new ProviderCatalog(directory, new InMemoryCredentialStore());
  expect(await catalog.capabilities(legacy)).toMatchObject({
    source: "endpoint",
    unknown: ["contextWindow", "maxOutputTokens", "images", "reasoning"],
    contextWindow: 32768,
    maxOutputTokens: 8192,
    images: undefined,
    reasoning: ["off"],
    speed: ["default"],
  });
  await catalog.saveDefault(selection);
  expect(await readModelDefault(directory)).toEqual(selection);
  expect(
    JSON.parse(await readFile(join(directory, "model-selection.json"), "utf8")),
  ).toEqual(selection);
});

it.each([
  { images: "yes" },
  { maxOutputTokens: 0 },
  { reasoning: [] },
  { reasoning: ["high", "high"] },
  { input: ["application/pdf"] },
  { contextWindow: 1000 },
  { reasoning: ["arbitrary"] },
])(
  "rejects malformed declarations before a model can be used: %j",
  async (endpointCapabilities) => {
    await expect(
      createPiProvider({ ...selection, endpointCapabilities } as any),
    ).rejects.toThrow();
  },
);

it("keeps host endpoint details private while resolving current and default scopes independently", async () => {
  const directory = await home();
  const runtime = await Runtime.open({
    home: directory,
    cwd: directory,
    ...selection,
    approve: async () => false,
  });
  runtimes.push(runtime);
  const session = await runtime.session();
  const selected = () => runtime.session(session.id);
  const invoke = (method: string, params: Record<string, unknown> = {}) =>
    libraryRequest(runtime, method, params, selected) as Promise<any>;
  const defaults = {
    ...selection,
    baseUrl: "http://localhost:11435/v1",
    endpointCapabilities: { contextWindow: 128000, images: true },
  };
  await runtime.saveDefaultSelection(defaults);
  expect(
    await invoke("model.capabilities", {
      provider: selection.provider,
      model: selection.model,
      scope: "active",
    }),
  ).toMatchObject({ contextWindow: 64000, images: false });
  expect(
    await invoke("model.capabilities", {
      provider: selection.provider,
      model: selection.model,
      scope: "default",
    }),
  ).toMatchObject({ contextWindow: 128000, images: true });
  expect(JSON.stringify(await invoke("model.read"))).not.toContain("localhost");
  await invoke("model.set", {
    provider: selection.provider,
    model: selection.model,
    settings: { reasoning: "high", contextWindow: 48000 },
  });
  expect((await selected()).modelSelection?.endpointCapabilities).toEqual(
    selection.endpointCapabilities,
  );
  await invoke("model.default", {
    provider: selection.provider,
    model: selection.model,
    scope: "default",
    settings: { contextWindow: 96000 },
  });
  expect((await readModelDefault(directory))?.baseUrl).toBe(defaults.baseUrl);
  for (const method of ["model.set", "model.default", "model.capabilities"])
    await expect(
      invoke(method, {
        provider: selection.provider,
        model: selection.model,
        endpointCapabilities: { images: true },
      }),
    ).rejects.toThrow(/host/);
  await runtime.setModel(await selected(), selection.provider, "other-model");
  expect(
    (await selected()).modelSelection?.endpointCapabilities,
  ).toBeUndefined();
  await runtime.setModel(
    await selected(),
    selection.provider,
    selection.model,
    undefined,
    "http://localhost:11436/v1",
  );
  expect(
    (await selected()).modelSelection?.endpointCapabilities,
  ).toBeUndefined();
});
