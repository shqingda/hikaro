import type { ImageInput } from "./types.ts";
export type PendingPrompt = {
  id: string;
  text: string;
  images?: ImageInput[];
  origin?: { scope?: string; commandId?: string };
};
export interface PendingPromptStore {
  pendingPrompts(sessionId: string): Promise<PendingPrompt[]>;
  insertPendingPrompt(sessionId: string, item: PendingPrompt): Promise<void>;
  updatePendingPrompt(
    sessionId: string,
    id: string,
    text: string,
  ): Promise<void>;
  prioritizePendingPrompt(sessionId: string, id: string): Promise<void>;
  takePendingPrompt(sessionId: string, id: string): Promise<boolean>;
}
