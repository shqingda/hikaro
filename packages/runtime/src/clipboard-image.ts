import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rmdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateImageInputs } from "./attachments.ts";

export const clipboardImageScript = `ObjC.import('AppKit');
const board = $.NSPasteboard.generalPasteboard;
const type = ObjC.unwrap(board.availableTypeFromArray(['public.png', 'public.tiff']));
if (!type) throw Error('No supported clipboard image');
let data = board.dataForType(type);
if (Number(data.length) > 33554432) throw Error('Clipboard image too large');
if (type === 'public.tiff') {
  const bitmap = $.NSBitmapImageRep.imageRepWithData(data);
  if (bitmap.isNil()) throw Error('Cannot decode clipboard image');
  data = bitmap.representationUsingTypeProperties($.NSPNGFileType, $({}));
}
if (data.isNil() || Number(data.length) > 4194304) throw Error('Clipboard image exceeds 4 MiB');
ObjC.unwrap(data.base64EncodedStringWithOptions(0));`;

async function readClipboard(): Promise<string> {
  if (process.platform !== "darwin")
    throw Error(
      "Clipboard images currently require macOS; use /attach PATH instead.",
    );
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", clipboardImageScript],
      {
        timeout: 10000,
        maxBuffer: 6 * 1024 * 1024,
      },
    );
    return stdout.trim();
  } catch {
    throw Error(
      "Cannot read clipboard image. Copy a PNG/image first (maximum 4 MiB), or use /attach PATH.",
    );
  }
}

/** Explicit user action only. Private temporary files keep unsent drafts usable. */
export async function saveClipboardImage(
  read = readClipboard,
): Promise<string> {
  const data = await read();
  validateImageInputs([{ mimeType: "image/png", data }]);
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "hikaro-clipboard-"),
  );
  const path = join(directory, "image.png");
  try {
    await writeFile(path, Buffer.from(data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    return path;
  } catch (error) {
    await rmdir(directory).catch(() => {});
    throw error;
  }
}
