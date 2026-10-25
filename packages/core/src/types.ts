import type { PlanReference } from "./change-evidence.ts";
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
  /** Maximum completion tokens actually requested by this adapter. */
  maxOutputTokens?: number;
  /** Undefined means a custom provider cannot determine image support locally. */
  supportsImages?: boolean;
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
  capability?: { kind: "file"; path: string; write: boolean };
  scope?: string;
  id: string;
  sessionId: string;
  /** Host-assigned authority for a live delegated task; never supplied by responders. */
  authoritySessionId?: string;
  tool: string;
  reason: string;
  arguments: Record<string, unknown>;
};
export interface ToolContext {
  /** Recheck cancellation and execution ownership after an asynchronous wait. */
  checkpoint?(): Promise<void>;
  readonlyResources?: readonly string[];
  outputDirectory?: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  callId: string;
  parentCallId?: string;
  /** Current model run, when the call belongs to one. */
  runId?: string;
  plan?: PlanReference;
  depth: number;
  budget: RunBudget;
  scope?: string;
  approve(
    reason: string,
    capability?: PermissionRequest["capability"],
  ): Promise<boolean>;
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
/** Optional host declaration for this exact compatible endpoint and model. */
export type EndpointCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  images?: boolean;
  reasoning?: Array<NonNullable<ModelSettings["reasoning"]>>;
};
export type ModelSelection = {
  provider: string;
  model: string;
  settings: ModelSettings;
  baseUrl?: string;
  endpointCapabilities?: EndpointCapabilities;
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
  items: Array<{ seq: number; message: Message & { imageCount?: number } }>;
  hasOlder: boolean;
  hasNewer: boolean;
};
export type SessionLease = { owner: string; epoch: number };
export type ContextCheckpoint = {
  seq: number;
  throughSeq: number;
  summary: string;
  timestamp: number;
};
export type ContextCheckpointInput = {
  throughSeq: number;
  summary: string;
  expectedCheckpointSeq: number;
  expectedLastMessageSeq: number;
};
export type ContextHistory = {
  messages: Message[];
  omitted: number;
  lastMessageSeq: number;
  checkpoint?: ContextCheckpoint;
};
export interface EventStore {
  createSession(
    cwd: string,
    title?: string,
    parentId?: string,
    modelSelection?: ModelSelection,
  ): Promise<Session>;
  sessions(
    offset?: number,
    limit?: number,
    cwd?: string,
    query?: string,
  ): Promise<Session[]>;
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
    lease?: SessionLease,
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
    options?: { after?: number },
  ): Promise<ContextHistory>;
  contextSourcePage(
    sessionId: string,
    options: { after: number; through: number; limit?: number },
  ): Promise<Array<{ seq: number; message: Message }>>;
  commitContextCheckpoint(
    sessionId: string,
    checkpoint: ContextCheckpointInput,
    lease: SessionLease,
    signal?: AbortSignal,
  ): Promise<ContextCheckpoint>;
  acquireLease(
    sessionId: string,
    owner: string,
  ): Promise<SessionLease | undefined>;
  renewLease(sessionId: string, lease: SessionLease): Promise<boolean>;
  assertLease(sessionId: string, lease?: SessionLease): Promise<void>;
  releaseLease(sessionId: string, lease: SessionLease): Promise<void>;
  close(): Promise<void>;
}
export interface AgentBackend {
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  cancel(): void;
  steer(text: string): void | Promise<void>;
  subscribe(fn: (event: AgentEvent) => void): () => void;
}
export interface Plugin {
  id: string;
  apiVersion: 1;
  setup(
    host: PluginHost,
  ): Promise<void | (() => Promise<void>)> | void | (() => Promise<void>);
}
export interface PluginExecutionContext {
  invocationId: string;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  checkpoint(): Promise<void>;
}
export type PluginCommand = (
  args: string,
  context: PluginExecutionContext,
) => Promise<string>;
export type PluginView = (context: PluginExecutionContext) => Promise<string>;
export interface PluginHost {
  registerProvider(id: string, factory: () => Promise<ProviderAdapter>): void;
  onEvent(listener: (event: AgentEvent) => void): void;
  registerView(id: string, render: PluginView): void;
  registerTool(tool: Tool): void;
  registerTools(tools: Tool[]): void;
  unregisterTools(names: string[]): void;
  registerCommand(name: string, run: PluginCommand): void;
}
