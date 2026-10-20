import type { Questions } from "./planning.ts";
export type PendingQuestion = {
  id: string;
  sessionId: string;
  executionSessionId: string;
  scope: string;
  hostInstanceId: string;
  questions: Questions;
};
