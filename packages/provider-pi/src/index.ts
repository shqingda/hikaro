import {
  modelCapabilities,
  validateModelSettings,
  type ModelSettings,
} from "./settings.ts";
import { compatibleEndpointProvider, endpointModel } from "./endpoint.ts";
import type {
  ProviderAdapter,
  Message,
  ProviderEvent,
  EndpointCapabilities,
} from "../../core/src/types.ts";
import type {
  Model,
  Api,
  Message as PiMessage,
  AssistantMessage,
  ThinkingLevel,
  JsonObject,
  CredentialStore,
  MutableModels,
} from "@earendil-works/pi-ai";
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function toPi(message: Message, model: Model<Api>): PiMessage {
  if (message.role === "user")
    return {
      role: "user",
      content: message.images?.length
        ? [
            { type: "text", text: message.text },
            ...message.images.map((i) => ({ type: "image" as const, ...i })),
          ]
        : message.text,
      timestamp: message.timestamp,
    };
  if (message.role === "tool")
    return {
      role: "toolResult",
      toolCallId: message.callId!,
      toolName: message.name!,
      content: [
        { type: "text", text: message.text },
        ...(message.images ?? []).map((i) => ({
          type: "image" as const,
          ...i,
        })),
      ],
      isError: message.isError ?? false,
      timestamp: message.timestamp,
    };
  if (message.providerData) return message.providerData as AssistantMessage;
  return {
    role: "assistant",
    content: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...(message.toolCalls ?? []).map((t) => ({
        type: "toolCall" as const,
        ...t,
        arguments: t.arguments as JsonObject,
      })),
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: message.toolCalls?.length ? "toolUse" : "stop",
    timestamp: message.timestamp,
  };
}
export async function createPiProvider(options: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  endpointCapabilities?: EndpointCapabilities;
  reasoning?: ThinkingLevel;
  contextWindow?: number;
  credentials?: CredentialStore;
  collection?: MutableModels;
  settings?: ModelSettings;
}): Promise<ProviderAdapter> {
  if (options.endpointCapabilities && !options.baseUrl)
    throw Error("Endpoint capabilities require a base URL");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  let models =
    options.collection ?? createModels({ credentials: options.credentials });
  if (!options.baseUrl && !options.collection) {
    if (!/^[a-z0-9-]+$/.test(options.provider))
      throw Error("Invalid provider identifier");
    try {
      const module = await import(
        `@earendil-works/pi-ai/providers/${options.provider}`
      );
      const factory = Object.entries(module).find(
        ([name, value]) =>
          name.endsWith("Provider") && typeof value === "function",
      )?.[1] as (() => any) | undefined;
      if (!factory) throw Error("No provider factory");
      models.setProvider(factory());
    } catch {
      const { builtinModels } =
        await import("@earendil-works/pi-ai/providers/all");
      models = builtinModels({ credentials: options.credentials });
    }
  }
  let model = models.getModel(options.provider, options.model);
  if (options.baseUrl) {
    model = endpointModel(options, options.contextWindow);
    // Keep endpoint auth isolated from the shared built-in provider collection.
    models = createModels();
    models.setProvider(
      await compatibleEndpointProvider(
        model as Model<"openai-completions">,
        options.credentials,
      ),
    );
  }
  if (!model)
    throw Error(
      `Unknown model ${options.provider}/${options.model}. Use --models or configure --base-url for a compatible server.`,
    );
  const preferences = validateModelSettings(
    model,
    options.settings ?? {
      contextWindow: options.contextWindow,
      reasoning: options.reasoning,
    },
  );
  const selected = model;
  const capabilities = modelCapabilities(
    selected,
    options.baseUrl ? (options.endpointCapabilities ?? null) : undefined,
  );
  const maxOutputTokens = Math.min(
    selected.maxTokens,
    16384,
    Math.max(
      256,
      Math.floor((preferences.contextWindow ?? selected.contextWindow) * 0.35),
    ),
  );
  return {
    id: options.provider,
    model: options.model,
    contextWindow: preferences.contextWindow ?? selected.contextWindow,
    maxOutputTokens,
    supportsImages: capabilities.images,
    async *stream(input): AsyncGenerator<ProviderEvent> {
      if (
        capabilities.images !== true &&
        input.messages.some((message) => message.images?.length)
      )
        throw Error(
          capabilities.images === false
            ? "This model does not support image input."
            : "Image support is unknown. Configure this endpoint with --endpoint-capabilities '{\"images\":true}' before sending images.",
        );
      const context = {
        systemPrompt: input.system,
        messages: input.messages.map((m) => toPi(m, selected)),
        tools: input.tools as any,
      };
      const settings = {
        signal: input.signal,
        apiKey: options.apiKey,
        reasoning:
          preferences.reasoning === "off" ? undefined : preferences.reasoning,
        sessionId: input.sessionId,
        maxTokens: maxOutputTokens,
      };
      const stream =
        preferences.speed && preferences.speed !== "default"
          ? models.stream(selected, context, {
              ...settings,
              serviceTier: preferences.speed,
              reasoningEffort:
                preferences.reasoning === "off"
                  ? "none"
                  : preferences.reasoning,
            } as any)
          : models.streamSimple(selected, context, settings);
      for await (const event of stream) {
        if (event.type === "text_delta")
          yield { type: "text", text: event.delta };
        else if (event.type === "thinking_delta")
          yield { type: "thinking", text: event.delta };
        else if (event.type === "error")
          throw Error(event.error.errorMessage ?? `Provider ${event.reason}`);
        else if (event.type === "done") {
          const m = event.message;
          yield {
            type: "done",
            message: {
              role: "assistant",
              text: m.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join(""),
              thinking:
                m.content
                  .filter((c) => c.type === "thinking")
                  .map((c) => c.thinking)
                  .join("") || undefined,
              toolCalls: m.content
                .filter((c) => c.type === "toolCall")
                .map((c) => ({
                  id: c.id,
                  name: c.name,
                  arguments: c.arguments,
                })),
              timestamp: m.timestamp,
              providerData: m,
            },
            usage: {
              input: m.usage.input,
              output: m.usage.output,
              cost: m.usage.cost.total,
            },
          };
        }
      }
    },
  };
}
export async function listModels() {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  return builtinModels()
    .getModels()
    .map((m) => ({ provider: m.provider, id: m.id, context: m.contextWindow }));
}
/** Offline fixture for UI development and deterministic integration tests. Never selected as a fallback. */
export function demoProvider(): ProviderAdapter {
  return {
    id: "demo",
    model: "offline",
    contextWindow: 32000,
    async *stream({ messages, signal }) {
      const prompt = messages.at(-1)?.text ?? "";
      const text = `Hikaro is ready.\n\nThis is **offline demo mode**. No model request or tool execution occurred.\n\nYou wrote: ${prompt}`;
      for (const part of text.match(/.{1,12}/gs) ?? []) {
        signal.throwIfAborted();
        yield { type: "text", text: part };
        await new Promise((r) => setTimeout(r, 12));
      }
      yield {
        type: "done",
        message: { role: "assistant", text, timestamp: Date.now() },
        usage: { input: 0, output: 0, cost: 0 },
      };
    },
  };
}
