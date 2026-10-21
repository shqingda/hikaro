import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, unlink, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  saveClipboardImage,
  clipboardImageScript,
} from "../packages/runtime/src/clipboard-image.ts";
function chunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk("IEND", Buffer.alloc(0)),
]).toString("base64");
it("stores validated clipboard bytes privately and rejects invalid images", async () => {
  const path = await saveClipboardImage(async () => png);
  try {
    expect((await readFile(path)).toString("base64")).toBe(png);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    await expect(
      saveClipboardImage(async () => "not an image"),
    ).rejects.toThrow();
  } finally {
    await unlink(path);
    await rmdir(dirname(path));
  }
});
it.runIf(process.platform === "darwin")(
  "runs native PNG and TIFF conversion without accessing the user's clipboard",
  async () => {
    for (const type of ["public.png", "public.tiff"]) {
      const script = clipboardImageScript.replace(
        "const board = $.NSPasteboard.generalPasteboard;",
        `
const png = $.NSData.alloc.initWithBase64EncodedStringOptions('${png}', 0);
const board = {
  availableTypeFromArray: () => $('${type}'),
  dataForType: () => ${type === "public.png" ? "png" : "$.NSBitmapImageRep.imageRepWithData(png).TIFFRepresentation"}
};`,
      );
      const { stdout } = await promisify(execFile)(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script],
        { timeout: 10000 },
      );
      const path = await saveClipboardImage(async () => stdout.trim());
      await unlink(path);
      await rmdir(dirname(path));
    }
  },
);
