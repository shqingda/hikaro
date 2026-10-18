import { it, expect } from "vitest";
import { resolve } from "node:path";
import { switchPreview } from "../scripts/mobile-lab.mjs";

it("switches only its own preview and refuses to stop another project's process", async () => {
  for (const sameProject of [false, true]) {
    const killed: number[] = [];
    const io = {
      run: async (command: string, args: string[]) => {
        if (command === "ps") return "serve-sim OLD-DEVICE";
        if (args.includes("-Fn"))
          return "n" + (sameProject ? resolve(".") : "/another-project");
        return killed.length ? "" : "123";
      },
      readdir: async () => ["server-ABC-123.json"],
      readFile: async () =>
        JSON.stringify({ device: "OLD-DEVICE", port: 3200, pid: 123 }),
      kill: (pid: number) => {
        killed.push(pid);
      },
      pause: async () => {},
    };
    if (sameProject) {
      await switchPreview("LAB-DEVICE", io);
      expect(killed).toEqual([123]);
    } else {
      await expect(switchPreview("LAB-DEVICE", io)).rejects.toThrow(
        /another project/,
      );
      expect(killed).toEqual([]);
    }
  }
});
