import * as z from "zod";
export const planReferenceSchema = z.object({
  sessionId: z.string().max(128),
  planId: z.string().uuid(),
  step: z.number().int().min(1).max(12).optional(),
});
export type PlanReference = z.infer<typeof planReferenceSchema>;
export const changeOriginSchema = z.object({
  callId: z.string().max(128),
  tool: z.string().max(256).optional(),
  plan: planReferenceSchema.optional(),
});
export type ChangeOrigin = z.infer<typeof changeOriginSchema>;
