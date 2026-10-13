import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { modelCapabilities, type ModelSettings } from "./settings.ts";
import type { ModelSelection } from "../../core/src/types.ts";
import { z } from "zod";
const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  settings: z
    .object({
      contextWindow: z.number().int().min(1024).optional(),
      reasoning: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      speed: z.enum(["default", "priority", "flex"]).optional(),
    })
    .default({}),
  baseUrl: z.url().optional(),
});
export async function readModelDefault(
  home: string,
): Promise<ModelSelection | undefined> {
  try {
    return selectionSchema.parse(
      JSON.parse(await readFile(join(home, "model-selection.json"), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
import type {
  MutableModels,
  CredentialStore,
  AuthInteraction,
  AuthType,
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";
export type ProviderChoice = {
  id: string;
  name: string;
  configured: boolean;
  stored: boolean;
  methods: Array<{ id: AuthType; label: string }>;
};
export type ModelChoice = { provider: string; id: string; name: string };
class CatalogCache implements ModelsStore {
  constructor(private home: string) {}
  async read(id: string) {
    try {
      return JSON.parse(
        await readFile(join(this.home, "models", id + ".json"), "utf8"),
      ) as ModelsStoreEntry;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return undefined;
    }
  }
  async write(id: string, entry: ModelsStoreEntry) {
    const dir = join(this.home, "models");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, id + "." + randomUUID() + ".tmp");
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await rename(temp, join(dir, id + ".json"));
  }
  async delete(id: string) {
    const { rm } = await import("node:fs/promises");
    await rm(join(this.home, "models", id + ".json"), { force: true });
  }
}
export class ProviderCatalog {
  private models?: MutableModels;
  constructor(
    private home: string,
    readonly credentials: CredentialStore,
  ) {}
  async collection() {
    if (!this.models) {
      const { builtinModels } =
        await import("@earendil-works/pi-ai/providers/all");
      this.models = builtinModels({
        credentials: this.credentials,
        modelsStore: new CatalogCache(this.home),
      });
      await this.models.refresh({ allowNetwork: false });
    }
    return this.models;
  }
  async providers(): Promise<ProviderChoice[]> {
    const models = await this.collection();
    const stored = new Set(
      (await this.credentials.list()).map((v) => v.providerId),
    );
    const choices = await Promise.all(
      models.getProviders().map(async (p) => {
        let configured = false;
        try {
          configured = !!(await models.checkAuth(p.id));
        } catch {}
        return {
          id: p.id,
          name: p.name,
          configured,
          stored: stored.has(p.id),
          methods: [
            ...(p.auth.oauth
              ? [
                  {
                    id: "oauth" as const,
                    label: p.auth.oauth.loginLabel ?? "Sign in with an account",
                  },
                ]
              : []),
            ...(p.auth.apiKey?.login
              ? [{ id: "api_key" as const, label: "Sign in with an API key" }]
              : []),
          ],
        };
      }),
    );
    return choices.sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name),
    );
  }
  async available(provider?: string): Promise<ModelChoice[]> {
    return (await (await this.collection()).getAvailable(provider)).map(
      (m) => ({ provider: m.provider, id: m.id, name: m.name }),
    );
  }
  async refresh(provider: string, signal: AbortSignal) {
    const result = await (
      await this.collection()
    ).refresh({ providers: [provider], force: true, signal });
    return result.errors.get(provider)?.message;
  }
  async login(provider: string, type: AuthType, interaction: AuthInteraction) {
    await (
      await this.collection()
    ).login(provider, type, interaction, { agentName: "Hikaro" });
  }
  async capabilities(provider: string, model: string) {
    if (provider === "demo" && model === "offline")
      return {
        contextWindow: 32000,
        reasoning: ["off"] as const,
        speed: ["default"] as const,
      };
    const selected = (await this.collection()).getModel(provider, model);
    if (!selected) throw Error("Model not found");
    return modelCapabilities(selected);
  }
  async readDefault() {
    return readModelDefault(this.home);
  }
  async saveDefault(
    provider: string,
    model: string,
    settings?: ModelSettings,
    baseUrl?: string,
  ) {
    const temp = join(this.home, ".model-" + randomUUID() + ".tmp");
    await writeFile(
      temp,
      JSON.stringify(
        selectionSchema.parse({ provider, model, settings, baseUrl }),
      ),
      {
        mode: 0o600,
      },
    );
    await rename(temp, join(this.home, "model-selection.json"));
  }
}
