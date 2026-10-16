import { createHash } from "node:crypto";
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
