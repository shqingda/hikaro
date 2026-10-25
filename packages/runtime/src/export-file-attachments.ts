import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SQLiteStore } from "../../storage/src/index.ts";
import type { FileHandle } from "node:fs/promises";
import { validateFileInputs } from "./attachments.ts";

/** Read only the selected message's structured file slots, never transcript paths. */
export async function exportFileAttachments(
  store: SQLiteStore,
  sessionId: string,
  seq: number,
  count: number,
  assets: string,
  file: FileHandle,
  signal: AbortSignal,
) {
  for (let index = 0; index < Math.min(count, 8); index++) {
    signal.throwIfAborted();
    let saved: NonNullable<ReturnType<typeof validateFileInputs>>[number];
    try {
      const first = await store.messageContent(
        sessionId,
        seq,
        "file",
        0,
        65536,
        index,
      );
      if (
        !Number.isSafeInteger(first.total) ||
        first.total > Math.ceil((4 * 1024 * 1024) / 3) * 4
      )
        throw Error("file exceeds 4 MiB limit");
      let data = "",
        part = first;
      for (;;) {
        signal.throwIfAborted();
        if (
          part.encoding !== "base64" ||
          part.total !== first.total ||
          part.name !== first.name ||
          part.sha256 !== first.sha256 ||
          part.mimeType !== first.mimeType ||
          data.length + part.data.length > first.total
        )
          throw Error("invalid saved file page");
        data += part.data;
        if (part.nextOffset === null) {
          if (data.length !== first.total) throw Error("incomplete saved file");
          break;
        }
        if (!part.data.length || part.nextOffset !== data.length)
          throw Error("invalid saved file cursor");
        part = await store.messageContent(
          sessionId,
          seq,
          "file",
          data.length,
          65536,
          index,
        );
      }
      saved = validateFileInputs([
        {
          name: first.name!,
          mimeType: first.mimeType as "application/octet-stream",
          sha256: first.sha256!,
          data,
        },
      ])![0]!;
    } catch {
      signal.throwIfAborted();
      await file.write(
        `[File ${index + 1} unavailable: missing, invalid or too large; no file was packaged.]\n\n`,
      );
      continue;
    }
    await mkdir(assets, { recursive: true, mode: 0o700 });
    const extension = extname(saved.name).toLowerCase();
    const name = `${seq}-file-${index + 1}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin"}`;
    await writeFile(join(assets, name), Buffer.from(saved.data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    const label = saved.name.replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&");
    await file.write(
      `[${label}](${basename(assets)}/${name}) — ${saved.mimeType}; SHA-256 ${saved.sha256}. Saved for export; binary content was not sent to the model.\n\n`,
    );
  }
  if (count > 8)
    await file.write(
      "[Additional file slots unavailable: exceeds the 8 attachment limit.]\n\n",
    );
}
