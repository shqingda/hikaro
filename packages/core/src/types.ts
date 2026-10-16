import type { z } from "zod";
export type Usage = { input: number; output: number; cost: number };
export type RunBudget = {
  usage: Usage;
  maxCost: number;
  modelCallsLeft: number;
};
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type ImageInput = { mimeType: string; data: string };
export type Message = {
  source?: "manual";
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ToolCall[];
  callId?: string;
  name?: string;
  isError?: boolean;
  images?: ImageInput[];
  providerData?: unknown;
  thinking?: string;
  timestamp: number;
};
export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; message: Message; usage: Usage };
export interface ProviderAdapter {
  id: string;
  model: string;
  contextWindow: number;
  stream(input: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
    signal: AbortSignal;
    sessionId?: string;
  }): AsyncIterable<ProviderEvent>;
}
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type ToolResult = {
  images?: ImageInput[];
  text: string;
  data?: unknown;
  isError?: boolean;
};
export type PermissionRequest = {
  scope?: string;
  id: string;
  sessionId: string;
  tool: string;
  reason: string;
  arguments: Record<string, unknown>;
};
export interface ToolContext {
  readonlyResources?: readonly string[];
  outputDirectory?: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  callId: string;
  depth: number;
  budget: RunBudget;
  scope?: string;
  approve(reason: string): Promise<boolean>;
  invoke(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  emit(type: string, data: Record<string, unknown>): Promise<void>;
}
export interface Tool {
  deferred?: boolean;
  name: string;
  description: string;
  schema: z.ZodType;
  parameters?: Record<string, unknown>;
  execute(args: any, context: ToolContext): Promise<ToolResult>;
}
export type ModelSettings = {
  contextWindow?: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  speed?: "default" | "priority" | "flex";
};
export type ModelSelection = {
  provider: string;
  model: string;
  settings: ModelSettings;
  baseUrl?: string;
};
export type Session = {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  parentId?: string;
  modelSelection?: ModelSelection;
};
export type AgentEvent = {
  sessionId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
};
export type MessagePage = {
  items: Array<{ seq: number; message: Message }>;
  hasOlder: boolean;
  hasNewer: boolean;
};
export interface EventStore {
  createSession(
    cwd: string,
    title?: string,
    parentId?: string,
    modelSelection?: ModelSelection,
  ): Promise<Session>;
  sessions(offset?: number, limit?: number, cwd?: string): Promise<Session[]>;
  session(id: string): Promise<Session | undefined>;
  messagePage(
    sessionId: string,
    options?: { before?: number; after?: number; limit?: number },
  ): Promise<MessagePage>;
  latestSeq(sessionId: string): Promise<number>;
  append(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<AgentEvent>;
  events(
    sessionId: string,
    after?: number,
    limit?: number,
  ): Promise<AgentEvent[]>;
  messages(sessionId: string, limit?: number): Promise<Message[]>;
  /** Bounded model history, starting at a user turn when older messages are omitted. */
  contextHistory(
    sessionId: string,
  ): Promise<{ messages: Message[]; omitted: number }>;
  acquire(sessionId: string, owner: string): Promise<boolean>;
  release(sessionId: string, owner: string): Promise<void>;
  claim(commandId: string, sessionId: string): Promise<boolean>;
  close(): Promise<void>;
}
export interface AgentBackend {
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  cancel(): void;
  steer(text: string): void;
  subscribe(fn: (event: AgentEvent) => void): () => void;
}
export interface Plugin {
  id: string;
  apiVersion: 1;
  setup(
    host: PluginHost,
  ): Promise<void | (() => Promise<void>)> | void | (() => Promise<void>);
}
export interface PluginHost {
  registerProvider(id: string, factory: () => Promise<ProviderAdapter>): void;
  onEvent(listener: (event: AgentEvent) => void): void;
  registerView(id: string, render: () => Promise<string>): void;
  registerTool(tool: Tool): void;
  registerTools(tools: Tool[]): void;
  registerCommand(name: string, run: (args: string) => Promise<string>): void;
}
