import { createHash } from "node:crypto";

/** Hex SHA-256 of text or bytes; used for content checks and stable file names. */
export const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** A message for any thrown value, including non-Error rejections. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
