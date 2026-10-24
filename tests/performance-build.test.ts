import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execute = promisify(execFile);
const buildOptionsPath = new URL(
  "../scripts/build-options.mjs",
  import.meta.url,
).href;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureDirectory() {
  // Keep Node's external package lookup in the installed repository graph.
  const directory = await mkdtemp(resolve(".hikaro-build-test-"));
  directories.push(directory);
  return directory;
}

describe("production startup packaging", () => {
  it("preserves external plugin Zod metadata, validation, Unicode width and native helper lookup", async () => {
    const { cliBuildOptions } = await import(buildOptionsPath);
    const directory = await fixtureDirectory();
    const tuiEntry = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-tui"),
    );
    const input = join(directory, "fixture.ts");
    await writeFile(
      input,
      `
      import { ToolRegistry } from ${JSON.stringify(resolve("packages/core/src/index.ts"))};
      import * as z from "zod";
      import { visibleWidth, Markdown } from "@earendil-works/pi-tui";
      import { getNativeModuleCandidates } from ${JSON.stringify(join(dirname(tuiEntry), "native-module-path.js"))};
      const externalZodUrl = ${JSON.stringify(import.meta.resolve("zod"))};
      const { z: pluginZod } = await import(externalZodUrl);
      const schema = pluginZod.object({ count: pluginZod.number().int().min(1).describe("Positive count") }).meta({ title: "External plugin input" });
      const tools = new ToolRegistry();
      tools.register({ name: "external", description: "fixture", schema, execute: async (input) => ({ text: String(input.count) }) });
      console.log(JSON.stringify({
        distinctCopies: z.object !== pluginZod.object,
        parameters: tools.definitions()[0].parameters,
        parsed: schema.parse({ count: 2 }),
        invalidRejected: !schema.safeParse({ count: 0 }).success,
        width: visibleWidth("A中"), markdown: typeof Markdown,
        nativeCandidates: getNativeModuleCandidates("native/fixture.node"),
      }));
    `,
    );
    const result = await build({
      ...cliBuildOptions(),
      entryPoints: { fixture: input },
      outdir: directory,
      sourcemap: false,
    });
    const { stdout } = await execute(process.execPath, [
      join(directory, "fixture.mjs"),
    ]);
    const value = JSON.parse(stdout);
    expect(value).toMatchObject({
      distinctCopies: true,
      parameters: {
        title: "External plugin input",
        properties: {
          count: { type: "integer", minimum: 1, description: "Positive count" },
        },
      },
      parsed: { count: 2 },
      invalidRejected: true,
      width: 3,
      markdown: "function",
    });
    expect(value.nativeCandidates[0]).toBe(
      join(dirname(tuiEntry), "../native/fixture.node"),
    );
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        path.includes("zod/v4/"),
      ),
    ).toBe(true);
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        path.includes("marked/lib/"),
      ),
    ).toBe(true);
  });

  it("starts the production launcher with disabled or unavailable compile cache", async () => {
    const { cliBuildOptions } = await import(buildOptionsPath);
    const directory = await fixtureDirectory();
    await build({ ...cliBuildOptions(), outdir: directory, sourcemap: false });
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "fixture");
    for (const env of [
      { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
      { ...process.env, NODE_COMPILE_CACHE: join(blocked, "cache") },
    ]) {
      const { stdout, stderr } = await execute(
        process.execPath,
        [join(directory, "hikaro.mjs"), "--help"],
        { env },
      );
      expect(stdout).toContain("Usage: hikaro");
      expect(stderr).toBe("");
    }
    expect(await readFile(join(directory, "hikaro.mjs"), "utf8")).toContain(
      "enableCompileCache",
    );
    const cache = join(directory, "empty-cache");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_COMPILE_CACHE: cache,
    };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const { stdout } = await execute(
      process.execPath,
      [join(directory, "hikaro.mjs"), "--help"],
      { env },
    );
    expect(stdout).toContain("Usage: hikaro");
    expect((await readdir(cache, { recursive: true })).length).toBeGreaterThan(
      0,
    );
  });
});

it("keeps host planning schemas out of the attached planning view graph", async () => {
  const { cliBuildOptions } = await import(buildOptionsPath);
  const directory = await fixtureDirectory();
  const result = await build({
    ...cliBuildOptions(),
    entryPoints: { planning: "packages/tui/src/planning.ts" },
    outdir: directory,
    write: false,
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some((path) => path.endsWith("runtime/src/plan-text.ts"))).toBe(
    true,
  );
  expect(inputs.some((path) => path.endsWith("runtime/src/planning.ts"))).toBe(
    false,
  );
  expect(inputs.some((path) => path.includes("/zod/"))).toBe(false);
});

it("does not retain unused Zod locales in the production graph", async () => {
  const { cliBuildOptions } = await import(buildOptionsPath);
  const result = await build({ ...cliBuildOptions(), write: false });
  const locales = new Set(
    Object.values(result.metafile!.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(
          ([path, input]) =>
            path.includes("zod/v4/locales/") && input.bytesInOutput > 0,
        )
        .map(([path]) => path.split("/").at(-1)),
    ),
  );
  expect([...locales]).toEqual(["en.js"]);
});

it("reports the packaged version without loading application chunks or creating a home", async () => {
  const { cliBuildOptions } = await import(buildOptionsPath);
  const directory = await fixtureDirectory();
  const resultBuild = await build({ ...cliBuildOptions(), outdir: directory });
  // Keep shared constants, remove the lazy application entry itself.
  const launcher = Object.entries(resultBuild.metafile!.outputs).find(
    ([file]) => file.endsWith("/hikaro.mjs"),
  )![1];
  const applicationImports = launcher.imports.filter(
    (entry) => entry.kind === "dynamic-import",
  );
  expect(applicationImports.length).toBeGreaterThan(0);
  for (const entry of applicationImports) await rm(resolve(entry.path));
  const source = JSON.parse(await readFile("package.json", "utf8"));
  const result = await execute(
    process.execPath,
    [join(directory, "hikaro.mjs"), "--version"],
    { cwd: directory },
  );
  expect(result.stdout.trim()).toBe(`hikaro ${source.version}`);
  expect(result.stderr).toBe("");
});
