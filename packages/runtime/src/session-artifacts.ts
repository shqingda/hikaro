import { basename, dirname, join, relative } from "node:path";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import {
  readFileBytes,
  SecureFileError,
} from "../../tools/src/secure-files.ts";

export const maxSessionArtifactBytes = 16 * 1024 * 1024;
export class SessionArtifactError extends Error {
  constructor(
    readonly kind: "missing" | "rejected" | "too-large" | "read-failed",
    message: string,
  ) {
    super(message);
  }
}

export function sessionArtifactPath(
  home: string,
  sessionId: string,
  path: unknown,
) {
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    ![
      join(home, "artifacts", sessionId),
      join(home, "outputs", sessionId),
    ].includes(dirname(path)) ||
    !/^(?:[a-f0-9]{64}\.json|[a-f0-9-]{36}\.log)$/.test(basename(path))
  )
    throw new SessionArtifactError(
      "rejected",
      "Artifact is not an authorized session output",
    );
  return path;
}

/** Canonicalize only the trusted home. The helper rejects every remaining symlink. */
export async function readSessionArtifact(
  home: string,
  sessionId: string,
  reference: unknown,
  signal: AbortSignal,
  limit = maxSessionArtifactBytes,
) {
  const path = sessionArtifactPath(home, sessionId, reference);
  // Canonicalize the trusted home only. Every remaining directory and the
  // file itself still pass the helper's no-symlink walk.
  const securePath = join(await realpath(home), relative(home, path));
  signal.throwIfAborted();
  try {
    return await readFileBytes(securePath, signal, limit);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SecureFileError) {
      const errno = constants.errno;
      if (error.errno === errno.ENOENT)
        throw new SessionArtifactError("missing", "Saved artifact is missing");
      if (error.errno === errno.EFBIG)
        throw new SessionArtifactError(
          "too-large",
          "Saved artifact exceeds the read limit",
        );
      if (
        [
          errno.ELOOP,
          errno.ENOTDIR,
          errno.EINVAL,
          errno.EACCES,
          errno.EPERM,
        ].includes(error.errno ?? -1)
      )
        throw new SessionArtifactError(
          "rejected",
          "Saved artifact cannot be safely accessed",
        );
      if ([errno.EIO, errno.ESTALE].includes(error.errno ?? -1))
        throw new SessionArtifactError(
          "read-failed",
          "Saved artifact could not be read",
        );
    }
    // Helper/protocol failures and cancellation are fatal, never missing resources.
    throw error;
  }
}
