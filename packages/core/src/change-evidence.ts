import * as z from "zod";
export const planReferenceSchema = z.object({
  sessionId: z.string().max(128),
  planId: z.string().uuid(),
  step: z.number().int().min(1).max(12).optional(),
});
export type PlanReference = z.infer<typeof planReferenceSchema>;
export const changeOriginSchema = z.object({
  callId: z.string().max(128),
  parentCallId: z.string().max(128).optional(),
  tool: z.string().max(256).optional(),
  plan: planReferenceSchema.optional(),
});
export type ChangeOrigin = z.infer<typeof changeOriginSchema>;

export const toolEvidenceSchema = z.object({
  sessionId: z.string().max(128),
  callId: z.string().max(128),
  parentCallId: z.string().max(128).optional(),
  name: z.string().max(80),
  runId: z.string().max(128).optional(),
  step: z.number().int().min(1).max(12).optional(),
  seq: z.number().int().positive(),
  status: z.enum(["completed", "failed", "unknown", "cancelled"]),
  preview: z.string().max(160),
});
export type ToolEvidence = z.infer<typeof toolEvidenceSchema>;
export const stepEvidenceSchema = z.object({
  reliable: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  tools: z.array(toolEvidenceSchema).max(60),
});
export type StepEvidence = z.infer<typeof stepEvidenceSchema>;
