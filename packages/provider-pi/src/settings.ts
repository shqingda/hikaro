import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelSettings } from "../../core/src/types.ts";
export type { ModelSettings } from "../../core/src/types.ts";

// Verified against the API pricing and Fast/Flex guides on 2026-10-13.
// Unknown IDs stay on the provider default; API support alone is insufficient.
const fastModels = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
]);
const flexModels = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);

function speedTiers(
  model: Model<Api>,
): Array<NonNullable<ModelSettings["speed"]>> {
  const tiers: Array<NonNullable<ModelSettings["speed"]>> = ["default"];
  const api = model.provider === "openai" && model.api === "openai-responses";
  const subscription =
    model.provider === "openai-codex" && model.api === "openai-codex-responses";
  if (!api && !subscription) return tiers;
  // Only accept an exact ID or its dated snapshot, never a new model variant.
  const id = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (fastModels.has(id)) tiers.push("priority");
  // Flex pricing belongs to the API; a subscription does not establish access.
  if (api && flexModels.has(id)) tiers.push("flex");
  return tiers;
}

export function modelCapabilities(model: Model<Api>) {
  return {
    contextWindow: model.contextWindow,
    reasoning: getSupportedThinkingLevels(model),
    speed: speedTiers(model),
  };
}
export function validateModelSettings(
  model: Model<Api>,
  settings: ModelSettings,
) {
  const cap = modelCapabilities(model);
  if (
    settings.contextWindow !== undefined &&
    (!Number.isInteger(settings.contextWindow) ||
      settings.contextWindow < 1024 ||
      settings.contextWindow > cap.contextWindow)
  )
    throw Error(
      `Context must be between 1k and ${Math.floor(cap.contextWindow / 1000)}k for this model.`,
    );
  if (
    settings.reasoning !== undefined &&
    !cap.reasoning.includes(settings.reasoning)
  )
    throw Error("This model does not support that reasoning level.");
  if (settings.speed !== undefined && !cap.speed.includes(settings.speed))
    throw Error("This model does not expose a speed tier.");
  return settings;
}
