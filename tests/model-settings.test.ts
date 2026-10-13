import { it, expect } from "vitest";
import {
  modelCapabilities,
  validateModelSettings,
} from "../packages/provider-pi/src/settings.ts";
import { authenticationUrl } from "../packages/tui/src/auth-browser.ts";
import { MessageComponent } from "../packages/tui/src/index.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
const model: Model<Api> = {
  id: "test",
  name: "test",
  provider: "xai",
  api: "openai-completions",
  baseUrl: "https://example.com",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
it("only offers supported reasoning and speed options and rejects excessive context", () => {
  const cap = modelCapabilities(model);
  expect(cap.reasoning).not.toContain("off");
  expect(cap.reasoning).not.toContain("max");
  expect(cap.reasoning).toContain("xhigh");
  expect(cap.speed).toEqual(["default"]);
  expect(() =>
    validateModelSettings(model, { contextWindow: 200000 }),
  ).toThrow();
  expect(() => validateModelSettings(model, { speed: "priority" })).toThrow();
  expect(
    modelCapabilities({ ...model, provider: "openai", api: "openai-responses" })
      .speed,
  ).toEqual(["default"]);
});
it("filters service tiers by model and distinguishes API from subscription access", () => {
  const apiModel: Model<Api> = {
    ...model,
    id: "gpt-6.1-sol",
    provider: "openai",
    api: "openai-responses",
  };
  expect(modelCapabilities(apiModel).speed).toEqual([
    "default",
    "priority",
    "flex",
  ]);
  expect(
    modelCapabilities({ ...apiModel, id: "gpt-6.1-sol-2026-10-01" }).speed,
  ).toEqual(["default", "priority", "flex"]);
  expect(
    modelCapabilities({ ...apiModel, id: "gpt-6.1-sol-pro" }).speed,
  ).toEqual(["default"]);
  expect(
    modelCapabilities({ ...apiModel, id: "ft:gpt-6.1-sol:custom" }).speed,
  ).toEqual(["default"]);
  expect(modelCapabilities({ ...apiModel, id: "gpt-5.6-sol" }).speed).toEqual([
    "default",
    "priority",
  ]);
  expect(
    modelCapabilities({
      ...apiModel,
      provider: "openai-codex",
      api: "openai-codex-responses",
    }).speed,
  ).toEqual(["default", "priority"]);
  expect(() =>
    validateModelSettings({ ...apiModel, id: "unknown" }, { speed: "flex" }),
  ).toThrow("does not expose a speed tier");
});
it("recognizes the device-code URL used by xAI authorization", () => {
  expect(
    authenticationUrl({
      type: "device_code",
      userCode: "123",
      verificationUri: "https://auth.example.com/device",
    }),
  ).toBe("https://auth.example.com/device");
  expect(
    authenticationUrl({
      type: "auth_url",
      url: "https://auth.example.com/login",
    }),
  ).toBe("https://auth.example.com/login");
});
it("uses a full-width brand-tinted user background without role headings", () => {
  const user = new MessageComponent(1, "user", "hi");
  const assistant = new MessageComponent(2, "assistant", "hello");
  const a = user.render(40).join("\n"),
    b = assistant.render(40).join("\n");
  expect(a).toContain("\x1b[48;");
  expect(a).not.toContain("You");
  expect(b).not.toContain("Hikaro");
  expect(b).not.toContain("\x1b[48;");
});

it("folds all history pages during compaction instead of dropping early goals", async () => {
  const { summarizeHistory } = await import("../packages/core/src/context.ts");
  let source = "";
  const provider = {
    id: "fixture",
    model: "fixture",
    contextWindow: 4000,
    async *stream(input: any) {
      source += input.messages[0].text;
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          text: "Goal and decisions preserved.",
          timestamp: 1,
        },
        usage: { input: 1, output: 1, cost: 0 },
      };
    },
  };
  const rows = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    message: {
      role: "user" as const,
      text:
        i === 0
          ? "EARLY_USER_GOAL"
          : i === 99
            ? "LAST_DECISION"
            : "message " + i,
      timestamp: i,
    },
  }));
  await summarizeHistory(
    provider,
    async (after) => rows.filter((r) => r.seq > after).slice(0, 20),
    new AbortController().signal,
  );
  expect(source).toContain("EARLY_USER_GOAL");
  expect(source).toContain("LAST_DECISION");
});
