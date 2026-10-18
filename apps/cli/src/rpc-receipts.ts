import { createHash } from "node:crypto";
import type { Command } from "../../../packages/protocol/src/index.ts";

const reads = new Set([
  "hello",
  "command.receipt",
  "session.current",
  "session.list",
  "messages.read",
  "events.read",
]);
export const isMutation = (method: string) => !reads.has(method);

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
