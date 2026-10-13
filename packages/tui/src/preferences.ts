import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const schema = z.object({
  version: z.literal(2).default(2),
  showToolDetails: z.boolean().default(false),
  showThinking: z.boolean().default(false),
  showUsage: z.boolean().default(true),
  completionBell: z.boolean().default(false),
  resumeOnStart: z.boolean().default(true),
});
export type TuiPreferences = z.infer<typeof schema>;
export const defaultTuiPreferences: TuiPreferences = schema.parse({});
export async function loadTuiPreferences(home: string) {
  try {
    const saved = JSON.parse(
      await readFile(join(home, "tui-preferences.json"), "utf8"),
    );
    // The old default was serialized as false, even when never chosen.
    if (saved.version !== 2) {
      saved.version = 2;
      saved.resumeOnStart = true;
    }
    return schema.parse(saved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { ...defaultTuiPreferences };
  }
}
export async function saveTuiPreferences(
  home: string,
  preferences: TuiPreferences,
) {
  const next = schema.parse(preferences);
  const temp = join(home, ".tui-" + randomUUID() + ".tmp");
  await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await rename(temp, join(home, "tui-preferences.json"));
  return next;
}
