import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  modelCapabilities,
  modelSettingsSchema,
  endpointCapabilitiesSchema,
} from "./settings.ts";
import { endpointModel } from "./endpoint.ts";
import type { ModelSelection } from "../../core/src/types.ts";
import * as z from "zod";
import {
  ModelPreferenceStore,
  type ModelReference,
} from "./model-preferences.ts";
const selectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    settings: modelSettingsSchema.default({}),
    baseUrl: z.url().optional(),
    endpointCapabilities: endpointCapabilitiesSchema.optional(),
  })
  .refine(
    (selection) => !selection.endpointCapabilities || !!selection.baseUrl,
    "Endpoint capabilities require a base URL",
  );
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
  /** Metadata only: saved credentials have not necessarily been verified. */
  source?: "stored" | "environment" | "none" | "unknown";
  credentialType?: AuthType;
  ambientSource?: string;
  statusReason?: string;
  methods: Array<{ id: AuthType; label: string }>;
};
export type ModelChoice = {
  provider: string;
  id: string;
  name: string;
  capabilities?: ReturnType<typeof modelCapabilities>;
};
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
  private browsing?: MutableModels;
  private preferences: ModelPreferenceStore;
  constructor(
    private home: string,
    readonly credentials: CredentialStore,
  ) {
    this.preferences = new ModelPreferenceStore(home);
  }
  async collection() {
    if (!this.models) {
      const { createModels, InMemoryCredentialStore } =
        await import("@earendil-works/pi-ai");
      const { builtinModels } =
        await import("@earendil-works/pi-ai/providers/all");
      const browsing = builtinModels({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new CatalogCache(this.home),
      });
      // Pi's offline refresh still reads credentials. Restore cached models with
      // an empty store, then share the providers with the authenticated runtime.
      await browsing.refresh({ allowNetwork: false });
      const models = createModels({
        credentials: this.credentials,
        modelsStore: new CatalogCache(this.home),
      });
      for (const provider of browsing.getProviders())
        models.setProvider(provider);
      this.browsing = browsing;
      this.models = models;
    }
    return this.models;
  }
  async providers(): Promise<ProviderChoice[]> {
    const models = await this.collection();
    const stored = new Map(
      (await this.credentials.list()).map((v) => [v.providerId, v.type]),
    );
    const choices = await Promise.all(
      models.getProviders().map(async (p) => {
        let ambientSource: string | undefined;
        let ambient = false;
        let statusReason: string | undefined;
        try {
          const check = await this.browsing!.checkAuth(p.id);
          ambient = !!check;
          ambientSource = check?.source;
        } catch {
          statusReason = "Environment availability could not be checked";
        }
        return {
          id: p.id,
          name: p.name,
          configured: stored.has(p.id) || ambient,
          stored: stored.has(p.id),
          source: stored.has(p.id)
            ? ("stored" as const)
            : ambient
              ? ("environment" as const)
              : statusReason
                ? ("unknown" as const)
                : ("none" as const),
          credentialType: stored.get(p.id),
          ambientSource,
          statusReason,
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
    return (await this.collection())
      .getModels(provider)
      .map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        capabilities: modelCapabilities(m),
      }));
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
  async logout(provider: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await (await this.collection()).logout(provider, { signal });
  }
  readPreferences() {
    return this.preferences.read();
  }
  setFavorite(model: ModelReference, enabled: boolean) {
    return this.preferences.setFavorite(model, enabled);
  }
  recordRecent(model: ModelReference) {
    return this.preferences.recordRecent(model);
  }
  async capabilities(
    selection: Pick<
      ModelSelection,
      "provider" | "model" | "baseUrl" | "endpointCapabilities"
    >,
  ) {
    const { provider, model } = selection;
    if (selection.baseUrl)
      return modelCapabilities(
        endpointModel(selection),
        selection.endpointCapabilities ?? null,
      );
    if (selection.endpointCapabilities)
      throw Error("Endpoint capabilities require a base URL");
    if (provider === "demo" && model === "offline")
      return {
        contextWindow: 32000,
        maxOutputTokens: 8192,
        images: false,
        reasoning: ["off"] as const,
        speed: ["default"] as const,
        source: "catalog" as const,
        unknown: [],
      };
    const selected = (await this.collection()).getModel(provider, model);
    if (!selected) throw Error("Model not found");
    return modelCapabilities(selected);
  }
  async readDefault() {
    return readModelDefault(this.home);
  }
  async saveDefault(selection: ModelSelection) {
    const temp = join(this.home, ".model-" + randomUUID() + ".tmp");
    await writeFile(temp, JSON.stringify(selectionSchema.parse(selection)), {
      mode: 0o600,
    });
    await rename(temp, join(this.home, "model-selection.json"));
  }
}
