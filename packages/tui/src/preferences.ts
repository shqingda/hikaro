import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/mini";
const schema = z.object({
  version: z._default(z.literal(2), 2),
  showToolDetails: z._default(z.boolean(), false),
  showThinking: z._default(z.boolean(), false),
  showUsage: z._default(z.boolean(), true),
  completionBell: z._default(z.boolean(), false),
  resumeOnStart: z._default(z.boolean(), true),
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
    return {
      ...defaultTuiPreferences,
    };
  }
}
export async function saveTuiPreferences(
  home: string,
  preferences: TuiPreferences,
) {
  const next = schema.parse(preferences);
  const temp = join(home, ".tui-" + randomUUID() + ".tmp");
  await writeFile(temp, JSON.stringify(next), {
    mode: 0o600,
  });
  await rename(temp, join(home, "tui-preferences.json"));
  return next;
}
