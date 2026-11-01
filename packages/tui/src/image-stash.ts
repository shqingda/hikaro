import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { sensitivePath } from "../../tools/src/workspace.ts";
import { sha256Hex } from "../../core/src/util.ts";

/** Provider uploads stop at 4 MiB; larger pastes are re-encoded on macOS. */
const sendLimit = 4 * 1024 * 1024;
const readLimit = 64 * 1024 * 1024;

const signatures: Array<[number[], number]> = [
  [[0x89, 0x50, 0x4e, 0x47], 0], // PNG
  [[0xff, 0xd8, 0xff], 0], // JPEG
  [[0x47, 0x49, 0x46, 0x38], 0], // GIF
  [[0x57, 0x45, 0x42, 0x50], 8], // WebP after RIFF....
];
const looksLikeImage = (bytes: Buffer) =>
  signatures.some(([magic, at]) =>
    magic.every((byte, index) => bytes[at + index] === byte),
  );

export const stashDirectory = () => join(tmpdir(), "hikaro-images");

/**
 * Copy a pasted image out of its source, as Claude Code and Grok Build keep
 * pasted bytes. macOS screenshot thumbnails live in a temporary folder that is
 * deleted seconds after the drag, so the original path is gone by send time.
 * Returns the original path when the file is not a plain image to copy.
 */
export function stashImage(path: string, directory = stashDirectory()) {
  try {
    const real = realpathSync(path);
    // Sensitive locations stay on the normal approval path at send time.
    if (sensitivePath.test(path) || sensitivePath.test(real)) return path;
    if (real.startsWith(directory + "/")) return path;
    const info = statSync(real);
    if (!info.isFile() || info.size > readLimit) return path;
    const bytes = readFileSync(real);
    if (!looksLikeImage(bytes)) return path;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const name = basename(real, extname(real)).replace(
      /[^\p{L}\p{N}._ -]/gu,
      "_",
    );
    const stem = join(directory, `${sha256Hex(bytes).slice(0, 12)}-${name}`);
    if (bytes.length > sendLimit && process.platform === "darwin") {
      const target = `${stem}.jpg`;
      execFileSync(
        "/usr/bin/sips",
        ["-Z", "2048", "-s", "format", "jpeg", real, "--out", target],
        { stdio: "ignore" },
      );
      chmodSync(target, 0o600);
      return target;
    }
    const target = stem + extname(real).toLowerCase();
    writeFileSync(target, bytes, { mode: 0o600 });
    return target;
  } catch {
    return path;
  }
}
