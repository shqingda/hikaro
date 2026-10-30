/** Portable contracts: this module must compile without Node or DOM ambient types. */
import * as z from "zod/mini";
export const protocolVersion = 2;
export const rpcMethods = [
  "storage.preview",
  "storage.cleanup",
  "plugins.list",
  "plugins.invoke",
  "plugins.cancel",
  "tool.manual",
  "session.export.file",
  "model.capabilities",
  "providers.reload",
  "permissions.set",
  "resources.list",
  "resources.reload",
  "resources.install",
  "changes.list",
  "changes.review.list",
  "changes.review.diff",
  "changes.detail",
  "changes.diff",
  "changes.rollback",
  "changes.redo",
  "execution.hold",
  "execution.release",
  "execution.read",
  "execution.history",
  "execution.history.detail",
  "execution.action",
  "plan.evidence",
  "plan.read",
  "plan.history",
  "plan.version",
  "plan.set",
  "plan.execute",
  "questions.read",
  "questions.respond",
  "questions.draft.read",
  "questions.draft.save",

  "hello",
  "command.receipt",
  "session.create",
  "session.list",
  "session.current",
  "session.resume",
  "session.fork",
  "session.compact",
  "workspace.current",
  "session.rename",
  "session.delete",
  "session.export",
  "draft.read",
  "draft.save",
  "models.list",
  "model.read",
  "model.set",
  "model.default",
  "messages.read",
  "messages.search",
  "messages.content",
  "artifact.read",
  "events.read",
  "prompt",
  "steer",
  "cancel",
  "run.cancel",
  "approval.respond",
  "client.detach",
] as const;
export type RpcMethod = (typeof rpcMethods)[number];
export const rpcReadMethods: ReadonlySet<string> = new Set([
  "storage.preview",
  "plugins.list",
  "model.capabilities",
  "resources.list",
  "changes.list",
  "changes.review.list",
  "changes.review.diff",
  "changes.detail",
  "changes.diff",
  "execution.read",
  "execution.history",
  "execution.history.detail",
  "plan.evidence",
  "plan.read",
  "plan.history",
  "plan.version",
  "questions.read",
  "questions.draft.read",

  "hello",
  "command.receipt",
  "workspace.current",
  "session.current",
  "session.list",
  "session.export",
  "draft.read",
  "models.list",
  "model.read",
  "messages.read",
  "messages.search",
  "messages.content",
  "artifact.read",
  "events.read",
]);
export type MessageSearchPage = {
  items: { seq: number; role: string; snippet: string }[];
  nextBefore: number | null;
};
/** Draft CAS and device push settings have no action intent and are never automatically replayed. */
export const rpcTransientMethods: ReadonlySet<string> = new Set([
  ...rpcReadMethods,
  "questions.draft.save",
]);
/** Partial UI state only; restoring a draft never submits any answers. */
export type QuestionDraft = {
  answers: Record<string, string>;
  inputs: Record<string, string>;
  position:
    { kind: "question" | "input"; questionId: string } | { kind: "review" };
};
export type QuestionDraftSnapshot = {
  revision: number;
  draft: QuestionDraft | null;
};
/** A conflict must not be retried with a new revision without explicit reconciliation. */
export type QuestionDraftSaveResult =
  { revision: number } | { conflict: true; current: QuestionDraftSnapshot };
export const HelloParams = z.object({
  protocolVersions: z.optional(
    z
      .array(z.int().check(z.gte(1)))
      .check(z.minLength(1))
      .check(z.maxLength(16)),
  ),
});
export function rpcCapabilities(sharedHost = false) {
  return {
    protocolVersion,
    supportedProtocolVersions: [protocolVersion],
    methods: [...rpcMethods],
    snapshotMethod: "session.current" as const,
    eventSequence: "global-monotonic-filtered-by-session" as const,
    scopeRevision: true as const,
    maxFrameBytes: 1_048_576,
    fileAttachments: true as const,
    commandReplay: "never-automatic" as const,
    // Preserve the original v2 marker for strict older clients.
    runIdentity: "events-only" as const,
    runSnapshotIdentity: true as const,
    durableCommandReceipts: true as const,
    runBoundSteering: true as const,
  };
}
const id = z.string().check(z.minLength(1)).check(z.maxLength(128));
export const RunCancelParams = z.object({ sessionId: id, runId: id });
/** Omitting the target preserves the original queue-for-next-turn semantics. */
export const SteerParams = z.object({
  text: z.string().check(z.minLength(1)).check(z.maxLength(100000)),
  sessionId: z.optional(id),
  expectedRunId: z.optional(id),
});
/** Acceptance records a stop request; the run's terminal event proves its outcome. */
export const RunCancelResult = z.object({
  accepted: z.literal(true),
  runId: id,
});
const sequence = z.int().check(z.gte(0)).check(z.lte(Number.MAX_SAFE_INTEGER));
export const HelloResult = z.object({
  fileAttachments: z.optional(z.boolean()),
  protocolVersion: z.literal(protocolVersion),
  supportedProtocolVersions: z.array(z.int()).check(z.maxLength(16)),
  methods: z
    .array(z.string().check(z.minLength(1)).check(z.maxLength(128)))
    .check(z.maxLength(128)),
  snapshotMethod: z.literal("session.current"),
  eventSequence: z.literal("global-monotonic-filtered-by-session"),
  scopeRevision: z.literal(true),
  maxFrameBytes: z.int().check(z.positive()).check(z.lte(1_048_576)),
  commandReplay: z.literal("never-automatic"),
  runIdentity: z.enum(["events-only", "snapshot-and-events"]),
  hostInstanceId: z.optional(id),
  durableCommandReceipts: z.optional(z.boolean()),
  runSnapshotIdentity: z.optional(z.boolean()),
  runBoundSteering: z.optional(z.boolean()),
});
export const Permission = z.object({
  id,
  sessionId: id,
  authoritySessionId: z.optional(id),
  tool: z.string().check(z.maxLength(256)),
  reason: z.string().check(z.maxLength(100000)),
  arguments: z.record(z.string(), z.unknown()),
  scope: z.optional(z.string().check(z.maxLength(80))),
  capability: z.optional(
    z.object({
      kind: z.literal("file"),
      path: z.string().check(z.maxLength(100000)),
      write: z.boolean(),
    }),
  ),
});
export const CurrentSession = z.object({
  sessionRole: z.optional(z.nullable(z.enum(["owner", "view", "control"]))),
  session: z.nullable(
    z.object({
      id,
      title: z.string().check(z.maxLength(100000)),
      cwd: z.string().check(z.maxLength(100000)),
      createdAt: z.number(),
      parentId: z.nullish(id),
      modelSelection: z.optional(
        z.object({
          provider: z.string().check(z.maxLength(128)),
          model: z.string().check(z.maxLength(256)),
        }),
      ),
    }),
  ),
  hostInstanceId: z.optional(id),
  runId: z.optional(z.nullable(id)),
  runStatus: z.optional(
    z.enum(["idle", "running", "completed", "failed", "cancelled", "unknown"]),
  ),
  busy: z.boolean(),
  stream: z.string().check(z.maxLength(100000)),
  streamTruncated: z.boolean(),
  cursor: sequence,
  revision: sequence,
  approvals: z.array(Permission).check(z.maxLength(64)),
});
export const EventFrame = z.object({
  type: z.literal("event"),
  scope: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  revision: sequence,
  hostInstanceId: z.optional(id),
  event: z.object({
    sessionId: id,
    seq: sequence,
    type: z.string().check(z.minLength(1)).check(z.maxLength(128)),
    data: z.record(z.string(), z.unknown()),
    timestamp: z.number(),
  }),
});
export const ApprovalFrame = z.object({
  type: z.literal("approval"),
  scope: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  revision: sequence,
  hostInstanceId: z.optional(id),
  request: Permission,
});
export const ResolvedFrame = z.object({
  type: z.literal("approval.resolved"),
  scope: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  revision: sequence,
  hostInstanceId: z.optional(id),
  id,
  allow: z.boolean(),
});
export const ResponseFrame = z.object({
  type: z.literal("response"),
  hostInstanceId: z.optional(id),
  scope: z.optional(z.string().check(z.minLength(1)).check(z.maxLength(80))),
  id,
  result: z.optional(z.unknown()),
  error: z.optional(z.string().check(z.maxLength(100000))),
});
export const InvalidatedFrame = z.object({
  type: z.literal("session.invalidated"),
  scope: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  revision: sequence,
  hostInstanceId: z.optional(id),
});
export type CurrentSession = z.infer<typeof CurrentSession>;
export type Permission = z.infer<typeof Permission>;
export type ScopedFrame =
  | z.infer<typeof EventFrame>
  | z.infer<typeof ApprovalFrame>
  | z.infer<typeof InvalidatedFrame>
  | z.infer<typeof ResolvedFrame>;

/** A receipt records command handling, not a guarantee of rolled-back side effects. */
export const DurableCommandReceipt = z.object({
  id,
  scope: z.string().check(z.minLength(1)).check(z.maxLength(80)),
  method: z.enum(rpcMethods),
  digest: z.nullable(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  hostInstanceId: z.nullable(id),
  sessionId: z.nullable(id),
  status: z.enum(["accepted", "completed", "failed", "unknown"]),
  runId: z.optional(id),
  operationId: z.optional(id),
  error: z.optional(z.string().check(z.maxLength(4096))),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DurableCommandReceipt = z.infer<typeof DurableCommandReceipt>;
export const CommandReceiptResult = z.object({
  receipt: z.nullable(DurableCommandReceipt),
});
