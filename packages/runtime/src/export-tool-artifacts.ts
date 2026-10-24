import { createHash } from "node:crypto";
import { mkdir, writeFile, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SQLiteStore } from "../../storage/src/index.ts";
import {
  maxSessionArtifactBytes,
  readSessionArtifact,
  sessionArtifactPath,
  SessionArtifactError,
} from "./session-artifacts.ts";

const maxCandidates = 100;
const maxTotalBytes = 64 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const line = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&");

/** Stream an explicit inventory. Never infer host file authority from transcript text. */
export async function exportToolArtifacts(options: {
  store: Pick<SQLiteStore, "toolArtifactPage">;
  home: string;
  sessionId: string;
  through: number;
  assets: string;
  file: Pick<FileHandle, "write">;
  signal: AbortSignal;
}) {
  const { store, home, sessionId, through, assets, file, signal } = options;
  let candidates = 0;
  let readBytes = 0;
  let writtenBytes = 0;
  let resourceNumber = 0;
  let started = false;
  const seen = new Map<string, { number: number; nestedOnly: boolean }>();

  async function resource(reference: unknown, parent?: number) {
    signal.throwIfAborted();
    const key =
      typeof reference === "string" && reference.length <= 4096
        ? reference
        : undefined;
    const previous = key === undefined ? undefined : seen.get(key);
    if (previous !== undefined && (!previous.nestedOnly || parent)) {
      await file.write(
        `- Resource ${previous.number}: repeated reference${parent ? ` (dependency of resource ${parent})` : ""}; see its earlier entry.\n\n`,
      );
      return;
    }
    const number = previous?.number ?? ++resourceNumber;
    const label = `Resource ${number}${parent ? ` (dependency of resource ${parent})` : ""}`;
    const unavailable = (reason: string) =>
      file.write(`- ${label}: Not packaged — ${reason}.\n\n`);
    if (previous === undefined && candidates >= maxCandidates) {
      await unavailable(
        "100 candidate limit reached; JSON dependencies not inspected",
      );
      return;
    }
    if (previous === undefined) candidates++;
    const record = { number, nestedOnly: false };
    if (key !== undefined) seen.set(key, record);
    let path: string;
    try {
      path = sessionArtifactPath(home, sessionId, reference);
    } catch (error) {
      if (!(error instanceof SessionArtifactError)) throw error;
      await unavailable("Rejected: not an authorized session output");
      return;
    }
    if (parent && !path.endsWith(".log")) {
      record.nestedOnly = true;
      await unavailable(
        "Unsupported dependency: only one level of saved logs is followed",
      );
      return;
    }
    const remainingRead = maxTotalBytes - readBytes;
    if (remainingRead === 0 || writtenBytes === maxTotalBytes) {
      await unavailable(
        "64 MiB read/output budget reached; JSON dependencies not inspected",
      );
      return;
    }
    let source: Buffer;
    const readLimit = Math.min(maxSessionArtifactBytes, remainingRead);
    try {
      source = await readSessionArtifact(
        home,
        sessionId,
        path,
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        readLimit,
      );
    } catch (error) {
      if (!(error instanceof SessionArtifactError)) throw error;
      // ESTALE/EIO may arrive after the helper consumed the entire allowance.
      if (error.kind === "read-failed") readBytes += readLimit;
      const reasons = {
        missing: "Missing: saved artifact no longer exists",
        rejected: "Rejected: unsafe or inaccessible file",
        "read-failed": "Read failed: saved file changed or could not be read",
        "too-large":
          remainingRead < maxSessionArtifactBytes
            ? "64 MiB read budget would be exceeded; JSON dependencies not inspected"
            : "16 MiB per-file limit exceeded; JSON dependencies not inspected",
      };
      await unavailable(reasons[error.kind]);
      return;
    }
    readBytes += source.length;
    let bytes = source;
    const dependencies: unknown[] = [];
    const json = path.endsWith(".json");
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(source),
        );
      } catch {
        await unavailable("Invalid content: expected a saved JSON tool result");
        return;
      }
      if (!object(parsed) || typeof parsed.text !== "string") {
        await unavailable("Invalid content: saved tool result has no text");
        return;
      }
      // Explicit projection: arbitrary data/provider/extension fields are private.
      bytes = Buffer.from(
        JSON.stringify({
          text: parsed.text,
          ...(typeof parsed.isError === "boolean"
            ? { isError: parsed.isError }
            : {}),
        }) + "\n",
      );
      if (object(parsed.data)) {
        if (Object.hasOwn(parsed.data, "artifact"))
          dependencies.push(parsed.data.artifact);
        if (
          object(parsed.data.process) &&
          Object.hasOwn(parsed.data.process, "artifact")
        )
          dependencies.push(parsed.data.process.artifact);
      }
    }
    if (bytes.length > maxTotalBytes - writtenBytes) {
      await unavailable(
        "64 MiB output budget would be exceeded; JSON dependencies not inspected",
      );
      return;
    }
    signal.throwIfAborted();
    await mkdir(assets, { recursive: true, mode: 0o700 });
    const name = `tool-${number}.${json ? "json" : "log"}`;
    await writeFile(join(assets, name), bytes, { flag: "wx", mode: 0o600 });
    writtenBytes += bytes.length;
    const digest = createHash("sha256").update(bytes).digest("hex");
    await file.write(
      `- ${label}: [${name}](${basename(assets)}/${name}) — ${bytes.length} bytes; SHA-256 ${digest}${json ? "; user-visible text/error fields only" : ""}.\n\n`,
    );
    for (const dependency of dependencies) await resource(dependency, number);
  }

  let after = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await store.toolArtifactPage(sessionId, {
      after,
      through,
      limit: 100,
    });
    for (const item of page.items) {
      if (!started) {
        started = true;
        await file.write(
          "## Saved tool artifacts\n\nResources below were read at export time. JSON files contain only visible text/error fields. Copy the .assets folder with this Markdown.\n\n",
        );
      }
      await file.write(
        `Event ${item.seq}${item.name ? ` · ${line(item.name)}` : ""}\n\n`,
      );
      for (const reference of item.references)
        await resource("path" in reference ? reference.path : undefined);
    }
    if (!page.hasMore) break;
    if (page.after <= after || page.after > through)
      throw Error("Invalid tool artifact cursor during export");
    after = page.after;
  }
  signal.throwIfAborted();
}
