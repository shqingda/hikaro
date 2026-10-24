import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Keep the worker's runtime imports beside the copied entry point. */
export async function copyStorageWorker(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of [
    "worker.mjs",
    "pending-steering.mjs",
    "statement-cache.mjs",
    "question-drafts.mjs",
    "execution-history.mjs",
    "child-tasks.mjs",
    "terminal-records.mjs",
  ])
    await copyFile(
      new URL("../packages/storage/src/" + name, import.meta.url),
      join(directory, name),
    );
}
