import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { replaceTextFile } from "../../tools/src/secure-files.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const warning =
  "Snapshot cleanup removes saved diff, rollback and redo content. Change metadata, transcripts, drafts, plans, credentials, recovery receipts and tool outputs are retained. Shared files are excluded. No automatic expiry.";
type Candidate = {
  path: string;
  size: number;
  ino: number;
  dev: number;
  mtimeMs: number;
  ctimeMs: number;
};

/** Only session-owned snapshot bodies are eligible. Metadata and potentially
 * shared tool outputs are retained rather than inferring authority from text. */
export async function previewStorageCleanup(home: string, sessionId: string) {
  const root = await realpath(home);
  const files: Candidate[] = [];
  const usage = { snapshots: 0, toolOutputs: 0, metadata: 0, excludedFiles: 0 };
  let bytes = 0;
  for (const kind of [
    "changes",
    "observations",
    "outputs",
    "artifacts",
  ] as const) {
    const folder = join(
      root,
      kind,
      kind === "changes" || kind === "observations"
        ? hash(sessionId)
        : sessionId,
    );
    let names: string[];
    try {
      if ((await realpath(folder)) !== folder)
        throw Error("Storage directory is linked; cleanup refused");
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (names.length > 25000)
      throw Error("Storage inventory exceeds 25,000 files; cleanup refused");
    for (const name of names.sort()) {
      const path = join(folder, name),
        stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) {
        usage.excludedFiles++;
        continue;
      }
      if (kind === "outputs" || kind === "artifacts") {
        usage.toolOutputs += stat.size;
        continue;
      }
      if (!/^[a-f0-9]{64}\.txt$/.test(name)) {
        usage.metadata += stat.size;
        continue;
      }
      usage.snapshots += stat.size;
      // Bound one explicitly confirmed cleanup, without retaining file bodies.
      if (
        stat.size > 16 * 1024 * 1024 ||
        bytes + stat.size > 64 * 1024 * 1024 ||
        files.length >= 1000
      ) {
        usage.excludedFiles++;
        continue;
      }
      const { size, ino, dev, mtimeMs, ctimeMs } = stat;
      files.push({ path, size, ino, dev, mtimeMs, ctimeMs });
      bytes += size;
    }
  }
  return {
    preview: {
      sessionId,
      token: hash(JSON.stringify({ sessionId, files })),
      bytes,
      files: files.length,
      usage,
      warning,
    },
    candidates: files,
  };
}

export async function cleanStorageSnapshots(
  home: string,
  sessionId: string,
  token: string,
  signal: AbortSignal,
  checkpoint: () => Promise<void>,
) {
  const { preview, candidates } = await previewStorageCleanup(home, sessionId);
  if (preview.token !== token)
    throw Error("Storage changed; create and confirm a new cleanup preview");
  let bytes = 0,
    files = 0;
  try {
    for (const candidate of candidates) {
      signal.throwIfAborted();
      await replaceTextFile(
        candidate.path,
        signal,
        (text) => {
          if (
            text === undefined ||
            !candidate.path.endsWith(hash(text) + ".txt")
          )
            throw Error("Snapshot changed or is damaged; cleanup refused");
          return undefined;
        },
        async () => {
          await checkpoint();
          const stat = await lstat(candidate.path);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            Object.entries(candidate).some(
              ([key, value]) =>
                key !== "path" && stat[key as keyof typeof stat] !== value,
            )
          )
            throw Error(
              "Storage changed; create and confirm a new cleanup preview",
            );
        },
      );
      bytes += candidate.size;
      files++;
    }
  } catch (error) {
    throw Error(
      `Cleanup stopped after ${files} files / ${bytes} bytes; inspect a new preview before retrying. ${String(error)}`,
    );
  }
  return { files, bytes, warning };
}
