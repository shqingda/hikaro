/** Portable contracts: this module must compile without Node or DOM ambient types. */
import * as z from "zod";
export const protocolVersion = 2;
export const rpcMethods = [
  "hello",
  "command.receipt",
  "session.create",
  "session.list",
  "session.current",
  "session.resume",
  "session.fork",
  "session.compact",
  "messages.read",
  "events.read",
  "prompt",
  "steer",
  "cancel",
  "approval.respond",
  "client.detach",
] as const;
export type RpcMethod = (typeof rpcMethods)[number];
export const HelloParams = z.object({
  protocolVersions: z.array(z.number().int().min(1)).min(1).max(16).optional(),
});
export function rpcCapabilities() {
  return {
    protocolVersion,
    supportedProtocolVersions: [protocolVersion],
    methods: [...rpcMethods],
    snapshotMethod: "session.current" as const,
    eventSequence: "global-monotonic-filtered-by-session" as const,
    scopeRevision: true as const,
    maxFrameBytes: 1_048_576,
    commandReplay: "never-automatic" as const,
    // Preserve the original v2 marker for strict older clients.
    runIdentity: "events-only" as const,
    runSnapshotIdentity: true as const,
    durableCommandReceipts: true as const,
  };
}
const id = z.string().min(1).max(128);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const HelloResult = z.object({
  protocolVersion: z.literal(protocolVersion),
  supportedProtocolVersions: z.array(z.number().int()).max(16),
  methods: z.array(z.string().min(1).max(128)).max(128),
  snapshotMethod: z.literal("session.current"),
  eventSequence: z.literal("global-monotonic-filtered-by-session"),
  scopeRevision: z.literal(true),
  maxFrameBytes: z.number().int().positive().max(1_048_576),
  commandReplay: z.literal("never-automatic"),
  runIdentity: z.enum(["events-only", "snapshot-and-events"]),
  hostInstanceId: id.optional(),
  durableCommandReceipts: z.boolean().optional(),
  runSnapshotIdentity: z.boolean().optional(),
});
export const Permission = z.object({
  id,
  sessionId: id,
  tool: z.string().max(256),
  reason: z.string().max(100000),
  arguments: z.record(z.string(), z.unknown()),
  scope: z.string().max(80).optional(),
  capability: z
    .object({
      kind: z.literal("file"),
      path: z.string().max(100000),
      write: z.boolean(),
    })
    .optional(),
});
export const CurrentSession = z.object({
  session: z
    .object({
      id,
      title: z.string().max(100000),
      cwd: z.string().max(100000),
      createdAt: z.number(),
      parentId: id.nullish(),
    })
    .nullable(),
  hostInstanceId: id.optional(),
  runId: id.nullable().optional(),
  runStatus: z
    .enum(["idle", "running", "completed", "failed", "cancelled", "unknown"])
    .optional(),
  busy: z.boolean(),
  stream: z.string().max(100000),
  streamTruncated: z.boolean(),
  cursor: sequence,
  revision: sequence,
  approvals: z.array(Permission).max(64),
});
export const EventFrame = z.object({
  type: z.literal("event"),
  scope: z.string().min(1).max(80),
  revision: sequence,
  hostInstanceId: id.optional(),
  event: z.object({
    sessionId: id,
    seq: sequence,
    type: z.string().min(1).max(128),
    data: z.record(z.string(), z.unknown()),
    timestamp: z.number(),
  }),
});
export const ApprovalFrame = z.object({
  type: z.literal("approval"),
  scope: z.string().min(1).max(80),
  revision: sequence,
  hostInstanceId: id.optional(),
  request: Permission,
});
export const ResolvedFrame = z.object({
  type: z.literal("approval.resolved"),
  scope: z.string().min(1).max(80),
  revision: sequence,
  hostInstanceId: id.optional(),
  id,
  allow: z.boolean(),
});
export const ResponseFrame = z.object({
  type: z.literal("response"),
  hostInstanceId: id.optional(),
  scope: z.string().min(1).max(80).optional(),
  id,
  result: z.unknown().optional(),
  error: z.string().max(100000).optional(),
});
export type CurrentSession = z.infer<typeof CurrentSession>;
export type Permission = z.infer<typeof Permission>;
export type ScopedFrame =
  | z.infer<typeof EventFrame>
  | z.infer<typeof ApprovalFrame>
  | z.infer<typeof ResolvedFrame>;

/** A receipt records command handling, not a guarantee of rolled-back side effects. */
export const DurableCommandReceipt = z.object({
  id,
  scope: z.string().min(1).max(80),
  method: z.enum(rpcMethods),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  hostInstanceId: id.nullable(),
  sessionId: id.nullable(),
  status: z.enum(["accepted", "completed", "failed", "unknown"]),
  runId: id.optional(),
  operationId: id.optional(),
  error: z.string().max(4096).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DurableCommandReceipt = z.infer<typeof DurableCommandReceipt>;
export const CommandReceiptResult = z.object({
  receipt: DurableCommandReceipt.nullable(),
});
