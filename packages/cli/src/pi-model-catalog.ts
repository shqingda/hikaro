import type { PiBackend } from "../../pi-bridge/src/index.ts";
import type { ModelPickerCatalog } from "../../tui/src/model-picker.ts";

/** Metadata adapter only. Pi remains the sole owner of its credential store. */
export function piModelCatalog(
  backend: Pick<PiBackend, "availableModels" | "currentModel">,
): ModelPickerCatalog {
  return {
    available: async (provider) =>
      (await backend.availableModels()).filter(
        (model) => !provider || model.provider === provider,
      ),
    providers: async () => {
      const providers = new Set(
        (await backend.availableModels()).map((model) => model.provider),
      );
      if (backend.currentModel) providers.add(backend.currentModel.provider);
      return [...providers]
        .sort()
        .map((id) => ({
          id,
          name: id,
          configured: false,
          stored: false,
          source: "unknown" as const,
          statusReason:
            "Managed by Pi · accounts and credentials are configured in Pi",
          methods: [],
        }));
    },
    login: async () => {
      throw Error("Managed by Pi. Configure provider accounts in Pi.");
    },
    refresh: async (_provider, signal) => {
      signal.throwIfAborted();
      await backend.availableModels();
      signal.throwIfAborted();
      return undefined;
    },
  };
}
