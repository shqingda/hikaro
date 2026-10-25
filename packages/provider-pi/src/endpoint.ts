import { createHash } from "node:crypto";
import type { ModelSelection } from "../../core/src/types.ts";
import { endpointCapabilitiesSchema, reasoningLevels } from "./settings.ts";
import type {
  AuthOperationOptions,
  CredentialStore,
  Model,
  Provider,
} from "@earendil-works/pi-ai";

export function normalizeEndpointUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "Endpoint must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  return url.href.replace(/\/+$/, "");
}

/** A custom endpoint never shares a built-in provider's credential namespace. */
export function endpointCredentialId(baseUrl: string): string {
  return (
    "endpoint-" +
    createHash("sha256").update(normalizeEndpointUrl(baseUrl)).digest("hex")
  );
}

/** Pi's Model fields drive both request construction and capability validation. */
export function endpointModel(
  selection: Pick<
    ModelSelection,
    "provider" | "model" | "baseUrl" | "endpointCapabilities"
  >,
  contextWindow?: number,
): Model<"openai-completions"> {
  if (!selection.baseUrl)
    throw Error("Endpoint capabilities require a base URL");
  const declared = endpointCapabilitiesSchema.parse(
    selection.endpointCapabilities ?? {},
  );
  const levels = declared.reasoning ?? ["off"];
  return {
    id: selection.model,
    name: selection.model,
    provider: selection.provider,
    api: "openai-completions",
    baseUrl: normalizeEndpointUrl(selection.baseUrl),
    reasoning: levels.some((level) => level !== "off"),
    thinkingLevelMap: Object.fromEntries(
      reasoningLevels.map((level) => [
        level,
        levels.includes(level) ? (level === "off" ? "none" : level) : null,
      ]),
    ),
    // Unknown legacy endpoints retain image passthrough; absence is not a claim of support.
    input: declared.images === false ? ["text"] : ["text", "image"],
    contextWindow: declared.contextWindow ?? contextWindow ?? 32768,
    maxTokens: declared.maxOutputTokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // A provider label is not evidence of a custom endpoint's reasoning dialect.
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: levels.some((level) => level !== "off"),
      thinkingFormat: "openai",
    },
  };
}

export async function saveEndpointApiKey(
  credentials: CredentialStore,
  baseUrl: string,
  apiKey: string,
  options?: AuthOperationOptions,
): Promise<void> {
  const id = endpointCredentialId(baseUrl);
  if (!apiKey.trim() || /[\x00-\x1f\x7f]/.test(apiKey))
    throw Error(
      "Endpoint API key must be non-empty and contain no control characters.",
    );
  await credentials.modify(
    id,
    async () => ({ type: "api_key", key: apiKey }),
    options,
  );
}

export async function compatibleEndpointProvider(
  model: Model<"openai-completions">,
  credentials?: CredentialStore,
): Promise<Provider<"openai-completions">> {
  const { stream, streamSimple } =
    await import("@earendil-works/pi-ai/api/openai-completions");
  const id = endpointCredentialId(model.baseUrl);
  return {
    id: model.provider,
    name: model.provider,
    baseUrl: model.baseUrl,
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Endpoint API key",
        async resolve({ credential, signal }) {
          signal.throwIfAborted();
          // Models supplies an explicit per-request key as `credential`. A saved
          // endpoint key is the only fallback; provider env/keychain keys are excluded.
          const stored =
            credential ?? (await credentials?.read(id, { signal }));
          signal.throwIfAborted();
          if (stored && (stored.type !== "api_key" || !stored.key?.trim()))
            throw Error("Invalid saved endpoint API key.");
          return {
            auth: stored?.key
              ? { apiKey: stored.key }
              : {
                  // Pi/OpenAI requires a client key even for anonymous servers.
                  // Null removes the SDK-generated Authorization header on the wire.
                  apiKey: "local",
                  headers: { Authorization: null },
                },
          };
        },
      },
    },
    stream,
    streamSimple,
  };
}
