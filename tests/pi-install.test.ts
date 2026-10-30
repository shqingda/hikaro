import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installPi } from "../packages/pi-bridge/src/install.ts";
import { PiBackend } from "../packages/pi-bridge/src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(resolve(".hikaro-pi-test-"));
  directories.push(directory);
  const command = join(directory, "pi");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if(args[0] === '--version') { console.log(process.env.FAKE_PI_VERSION ?? '1.4.0'); }
else if(args[0] === 'install') {
  appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(args) + '\\n');
  if(process.env.FAKE_PI_FAIL) process.exitCode = 1;
} else {
  const lines = createInterface({input:process.stdin});
  lines.on('line', line => {
    const request = JSON.parse(line);
    const state = process.env.FAKE_PI_BAD ? {} : {sessionId:'fixture',isStreaming:false,isCompacting:false,messageCount:0,pendingMessageCount:0};
    console.log(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:state}));
  });
}
`,
    { mode: 0o755 },
  );
  const home = join(directory, "home");
  await mkdir(home);
  const extensionPath = join(directory, "pi-extension.mjs");
  await writeFile(
    extensionPath,
    "export const createPiExtension = options => options;\n",
  );
  const env = { ...process.env, FAKE_PI_LOG: join(directory, "install.log") };
  return { directory, command, home, extensionPath, env };
}

it("persists a home-specific official Pi install and updates only its owned wrapper", async () => {
  const options = await fixture();
  await writeFile(
    join(options.home, "pi-bridge.json"),
    JSON.stringify({ autoOpen: false, custom: "preserved" }),
  );
  const result = await installPi(options);
  expect(
    JSON.parse(await readFile(join(options.home, "pi-bridge.json"), "utf8")),
  ).toEqual({ autoOpen: true, custom: "preserved" });
  expect(
    JSON.parse((await readFile(options.env.FAKE_PI_LOG, "utf8")).trim()),
  ).toEqual(["install", result.path]);
  const installed = await import(pathToFileURL(result.path).href);
  expect(installed.default).toEqual({ home: options.home });
  await installPi(options);
  expect(
    (await readFile(options.env.FAKE_PI_LOG, "utf8")).trim().split("\n"),
  ).toHaveLength(2);
});

it("refuses an unrelated wrapper and enables auto-open only after install success", async () => {
  const options = await fixture();
  const wrapper = join(options.home, "pi-extension.mjs");
  await writeFile(wrapper, "// user file\n");
  await expect(installPi(options)).rejects.toThrow(/owned|belongs|overwrite/i);
  expect(await readFile(wrapper, "utf8")).toBe("// user file\n");
  await rm(wrapper);
  await writeFile(
    join(options.home, "pi-bridge.json"),
    '{"autoOpen":false,"custom":1}',
  );
  await expect(
    installPi({ ...options, env: { ...options.env, FAKE_PI_FAIL: "1" } }),
  ).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(options.home, "pi-bridge.json"), "utf8")),
  ).toEqual({ autoOpen: false, custom: 1 });
});

it("warns on an unverified Pi version and rejects an empty get_state response", async () => {
  const options = await fixture();
  const warnings: string[] = [];
  const backend = await PiBackend.connect(options.command, options.directory, {
    env: { ...options.env, FAKE_PI_VERSION: "2.0.0" },
    onWarning: (message) => warnings.push(message),
  });
  await backend.close();
  expect(warnings.join("\n")).toMatch(/2\.0\.0.*1\.4|1\.4.*2\.0\.0/);
  await expect(
    PiBackend.connect(options.command, options.directory, {
      env: { ...options.env, FAKE_PI_BAD: "1" },
    }),
  ).rejects.toThrow(/get_state|contract/i);
});

it("builds an extension with external Pi dependencies and launches its sibling CLI", async () => {
  const { directory } = await fixture();
  const optionsPath = "../scripts/build-options.mjs";
  const { piExtensionBuildOptions } = await import(optionsPath);
  const result = await build({
    ...piExtensionBuildOptions(),
    entryPoints: {
      "pi-extension": "extensions/pi/index.ts",
      "embedded-view": "packages/pi-bridge/src/view.ts",
    },
    outdir: directory,
  });
  expect(
    Object.keys(result.metafile!.inputs).some((path) =>
      path.includes("node_modules"),
    ),
  ).toBe(false);
  expect(
    Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .filter((item) => item.path.startsWith("@earendil-works/pi-tui"))
      .every((item) => item.path === "@earendil-works/pi-tui" && item.external),
  ).toBe(true);
  const { hikaroLaunch } = await import(
    pathToFileURL(join(directory, "pi-extension.mjs")).href
  );
  expect(hikaroLaunch({}).args).toEqual([
    join(directory, "hikaro.mjs"),
    "--rpc",
  ]);
  const viewModule = pathToFileURL(join(directory, "embedded-view.mjs")).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { PiBridgeView } from ${JSON.stringify(viewModule)};
    import { stripVTControlCharacters } from 'node:util';
    const client = {
      subscribe: () => () => {}, onExit: () => () => {}, close: async () => {},
      request: async method => method === 'messages.read'
        ? { items: [{ message: { role: 'assistant', text: '**Host Markdown**' } }] }
        : { id: 'embedded' },
    };
    const view = new PiBridgeView({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, client, () => {}, { resumeSessionId: 'embedded' });
    await new Promise(resolve => setImmediate(resolve));
    const output = stripVTControlCharacters(view.render(80).join('\\n'));
    if (!output.includes('Host Markdown') || output.includes('**Host Markdown**')) throw Error('Packaged host Markdown did not render');
    view.dispose();
    process.stdout.write('rendered');`,
  ]);
  expect(stdout).toBe("rendered");
});
