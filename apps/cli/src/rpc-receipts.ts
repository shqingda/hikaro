import { createHash } from "node:crypto";
import type { Command } from "../../../packages/protocol/src/index.ts";
import { rpcReadMethods } from "../../../packages/protocol/src/contracts.ts";

// Autosaved question drafts use their own revision CAS, not task receipts.
// This classification does not grant read-only clients mutation permission.
export const isMutation = (method: string) =>
  !rpcReadMethods.has(method) && method !== "questions.draft.save";

/** Object key order is irrelevant; array order and all JSON values are significant. */
export function commandDigest(command: Command): string {
  const canonical = JSON.stringify(
    { method: command.method, params: command.params },
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}
