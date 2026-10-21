import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
const exec = promisify(execFile);
it.skipIf(process.platform !== "darwin")(
  "workspace sandbox remains isolated without calling the imported forge APIs",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "hikaro-forge-probe-")),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "outside"), "outside-secret");
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("network-secret");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No server port");
    const probe = join(root, "probe.json");
    const run = async (command: string) => {
      let output = "";
      let failed = false;
      try {
        output = (
          await exec(
            process.execPath,
            [
              "--require",
              resolve("tests/fixtures/forge-probe.cjs"),
              resolve("packages/tools/src/sandbox-runner.mjs"),
              command,
            ],
            {
              cwd: workspace,
              timeout: 15000,
              env: { ...process.env, HIKARO_FORGE_PROBE: probe },
            },
          )
        ).stdout;
      } catch (error) {
        const e = error as { stdout?: string; killed?: boolean };
        expect(e.killed).not.toBe(true);
        failed = true;
        output = e.stdout ?? "";
      }
      expect(JSON.parse(await readFile(probe, "utf8"))).toEqual({
        loaded: true,
        calls: [],
      });
      return { output, failed };
    };
    try {
      expect(await run("printf allowed > inside; cat inside")).toEqual({
        output: "allowed",
        failed: false,
      });
      const denied = await run(`cat '${join(root, "outside")}'`);
      expect(denied.failed).toBe(true);
      expect(denied.output).not.toContain("outside-secret");
      const network = await run(
        `/usr/bin/curl --silent --max-time 2 http://127.0.0.1:${address.port}/`,
      );
      expect(network.failed).toBe(true);
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);

it("forge probe rejects an intentional API call as a positive control", async () => {
  const root = await mkdtemp(join(tmpdir(), "hikaro-forge-control-"));
  const probe = join(root, "probe.json");
  try {
    await expect(
      exec(
        process.execPath,
        [
          "--require",
          resolve("tests/fixtures/forge-probe.cjs"),
          "-e",
          "const {createRequire}=require('node:module');const r=createRequire(require.resolve('@anthropic-ai/sandbox-runtime'));r('node-forge').md.sha256.create()",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HIKARO_FORGE_PROBE: probe },
        },
      ),
    ).rejects.toThrow(/Unexpected node-forge API/);
    const evidence = JSON.parse(await readFile(probe, "utf8"));
    expect(evidence.loaded).toBe(true);
    // forge.sha256 and forge.md.sha256 share the same object; the probe
    // records the first canonical alias cached for that function.
    expect(evidence.calls).toEqual(["forge.sha256.create"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
