import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerUrl, updatePlan } from "../apps/cli/src/self-update.ts";

describe("self update", () => {
  it("refuses source checkouts", async () => {
    await expect(updatePlan({})).rejects.toThrow(/install\.sh/);
  });

  it("reruns the public installer into the recorded install and bin directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "hk-update-"));
    try {
      await writeFile(
        join(root, "install.json"),
        JSON.stringify({ binDir: "/custom/bin", base: "" }),
      );
      const plan = await updatePlan({ HIKARO_INSTALL_ROOT: root });
      expect(plan.url).toBe(installerUrl);
      expect(plan.env).toMatchObject({
        HIKARO_INSTALL_DIR: root,
        HIKARO_BIN_DIR: "/custom/bin",
      });
      await writeFile(
        join(root, "install.json"),
        JSON.stringify({ binDir: "/b", base: "http://127.0.0.1:9/r" }),
      );
      const mirrored = await updatePlan({ HIKARO_INSTALL_ROOT: root });
      expect(mirrored.url).toBe("http://127.0.0.1:9/r/install.sh");
      expect(mirrored.env.HIKARO_DOWNLOAD_BASE).toBe("http://127.0.0.1:9/r");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
