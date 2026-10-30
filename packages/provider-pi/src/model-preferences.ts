import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ModelReference = { provider: string; model: string };
export type ModelPreferences = {
  favorites: ModelReference[];
  recent: ModelReference[];
};
export const modelKey = (model: ModelReference) =>
  `${model.provider}/${model.model}`;
const writes = new Map<string, Promise<unknown>>();

function references(value: unknown): ModelReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (
      !item ||
      typeof item.provider !== "string" ||
      !item.provider ||
      typeof item.model !== "string" ||
      !item.model
    )
      return [];
    const reference = { provider: item.provider, model: item.model };
    const key = modelKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    return [reference];
  });
}

/** Display preferences contain model IDs only; authentication stays in the credential store. */
export class ModelPreferenceStore {
  private file: string;
  constructor(private home: string) {
    this.file = join(home, "model-preferences.json");
  }
  async read(): Promise<ModelPreferences> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      return {
        favorites: references(value.favorites),
        recent: references(value.recent).slice(0, 10),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { favorites: [], recent: [] };
    }
  }
  private update(change: (value: ModelPreferences) => ModelPreferences) {
    const pending = (writes.get(this.file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(change(await this.read())), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temp, this.file);
        } finally {
          await rm(temp, { force: true });
        }
      });
    writes.set(this.file, pending);
    void pending
      .finally(() => {
        if (writes.get(this.file) === pending) writes.delete(this.file);
      })
      .catch(() => {});
    return pending;
  }
  setFavorite(model: ModelReference, enabled: boolean) {
    return this.update((value) => ({
      ...value,
      favorites: [
        ...value.favorites.filter((item) => modelKey(item) !== modelKey(model)),
        ...(enabled ? [model] : []),
      ],
    }));
  }
  recordRecent(model: ModelReference) {
    return this.update((value) => ({
      ...value,
      recent: [
        model,
        ...value.recent.filter((item) => modelKey(item) !== modelKey(model)),
      ].slice(0, 10),
    }));
  }
}
