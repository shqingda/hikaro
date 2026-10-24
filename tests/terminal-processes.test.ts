import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL("../packages/tools/src/process-snapshot-helper", import.meta.url),
);
type Snapshot = {
  incomplete: boolean;
  processes: { pid: number; startSec: string; startUsec: string }[];
  missing: number[];
  mismatched: number[];
  issues: { pid: number; kind: string }[];
};
async function snapshot(...identities: string[]): Promise<Snapshot> {
  const { stdout } = await execute(helper, identities, { timeout: 1000 });
  return JSON.parse(stdout);
}

async function processTree() {
  const root = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require('node:child_process');
const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
const stop = () => child.kill();
process.once('SIGTERM', stop);
child.once('exit', () => process.exit());
child.once('error', () => process.exit(1));
setTimeout(stop, 3000).unref();
console.log(child.pid);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = once(root, "close");
  const [output] = await once(root.stdout, "data");
  return {
    rootPid: root.pid!,
    childPid: Number(output.toString().trim()),
    async close() {
      root.kill("SIGTERM");
      await closed;
    },
  };
}

describe.skipIf(process.platform !== "darwin")(
  "terminal process identities",
  () => {
    it("observes an owned root and child but never follows a mismatched root identity", async () => {
      const tree = await processTree();
      try {
        const observed = await snapshot(`${tree.rootPid}:0:0`);
        expect(observed.processes.map((row) => row.pid).sort()).toEqual(
          [tree.rootPid, tree.childPid].sort(),
        );
        const root = observed.processes.find(
          (row) => row.pid === tree.rootPid,
        )!;
        const mismatched = await snapshot(
          `${root.pid}:${BigInt(root.startSec) + 1n}:${root.startUsec}`,
        );
        expect(mismatched.processes).toEqual([]);
        expect(mismatched.mismatched).toEqual([tree.rootPid]);
      } finally {
        await tree.close();
      }
    });

    it("refuses an unverified PID that is not the caller's direct child", async () => {
      const tree = await processTree();
      try {
        const result = await snapshot(`${tree.childPid}:0:0`);
        expect(result.processes).toEqual([]);
        expect(result.incomplete).toBe(true);
        expect(result.issues).toContainEqual({
          pid: tree.childPid,
          kind: "permission",
        });
      } finally {
        await tree.close();
      }
    });

    it("reports a missing identity without attributing other processes to it", async () => {
      const result = await snapshot("2147483647:1:0");
      expect(result.processes).toEqual([]);
      expect(result.missing).toEqual([2147483647]);
    });

    it.each([
      { identities: ["2:1:1000000"] },
      { identities: Array<string>(257).fill("2:1:0") },
    ])(
      "rejects invalid identity or input capacity (%#)",
      async ({ identities }) => {
        await expect(
          execute(helper, identities, { timeout: 1000 }),
        ).rejects.toMatchObject({
          code: 2,
          stdout: "",
        });
      },
    );
  },
);
