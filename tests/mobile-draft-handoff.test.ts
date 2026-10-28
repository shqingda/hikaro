import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientFiles } from "../packages/host/src/client-files.ts";
it("seeds a missing local-view draft once and never resurrects an explicitly cleared draft", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-draft-handoff-"));
  try {
    const files = await ClientFiles.open(home, "workspace", "local:main");
    const original = vi.fn(async () => "未发送中文草稿");
    expect(await files.draft("session", original)).toBe("未发送中文草稿");
    await files.saveDraft("session", "");
    expect(await files.draft("session", original)).toBe("");
    expect(original).toHaveBeenCalledOnce();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
