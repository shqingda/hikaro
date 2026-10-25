import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function readPiSettings(
  home: string,
): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(
      await readFile(join(home, "pi-bridge.json"), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid Pi bridge settings");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writePiFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function setPiAutoOpen(home: string, autoOpen: boolean) {
  const current = await readPiSettings(home);
  await writePiFile(
    join(home, "pi-bridge.json"),
    JSON.stringify({ ...current, autoOpen }) + "\n",
  );
}
