import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = vi.hoisted(() => ({ loaded: false }));
vi.mock("@earendil-works/pi-ai", async (original) => {
  sdk.loaded = true;
  return original();
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("startup dependency budget", () => {
  it("reads saved model selection without loading the aggregate provider SDK", async () => {
    const home = await mkdtemp(join(tmpdir(), "hikaro-model-startup-"));
    directories.push(home);
    const selected = {
      provider: "local",
      model: "offline-fixture",
      settings: { contextWindow: 32000 },
      baseUrl: "http://127.0.0.1:1234/v1",
    };
    await writeFile(
      join(home, "model-selection.json"),
      JSON.stringify(selected),
    );
    const { readModelDefault } =
      await import("../packages/provider-pi/src/catalog.ts");
    expect(await readModelDefault(home)).toEqual(selected);
    expect(sdk.loaded).toBe(false);
  });
});
