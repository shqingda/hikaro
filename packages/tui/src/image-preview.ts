import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "./primitives.ts";
import { accent, muted } from "./theme.ts";

type Pixels = {
  width: number;
  height: number;
  rgb: (x: number, y: number) => number[];
};

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

/** Decode the uncompressed 24/32-bit BMP that `sips` writes. */
export function decodeBmp(data: Buffer): Pixels {
  if (data.toString("latin1", 0, 2) !== "BM") throw Error("Not a BMP image");
  const offset = data.readUInt32LE(10);
  const width = data.readInt32LE(18);
  const rawHeight = data.readInt32LE(22);
  const bpp = data.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw Error(`Unsupported BMP depth ${bpp}`);
  const height = Math.abs(rawHeight);
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const bytes = bpp / 8;
  return {
    width,
    height,
    rgb(x, y) {
      const row = rawHeight > 0 ? height - 1 - y : y;
      const at = offset + row * stride + x * bytes;
      return [data[at + 2]!, data[at + 1]!, data[at]!];
    },
  };
}

/** Two pixel rows per terminal row: ▀ painted with the top pixel over the bottom one. */
export function halfBlocks(pixels: Pixels) {
  const lines: string[] = [];
  for (let y = 0; y < pixels.height; y += 2) {
    let line = "";
    for (let x = 0; x < pixels.width; x++) {
      const top = pixels.rgb(x, y).join(";");
      const bottom =
        y + 1 < pixels.height ? pixels.rgb(x, y + 1).join(";") : top;
      line += `\x1b[38;2;${top}m\x1b[48;2;${bottom}m▀`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

/** Scale an image to fit `columns` × `rows` cells with macOS `sips`, then draw it. */
async function renderImage(path: string, columns: number, rows: number) {
  if (process.platform !== "darwin")
    throw Error("Inline preview needs macOS; press O to open the image.");
  const info = await run("/usr/bin/sips", [
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    path,
  ]);
  const width = Number(/pixelWidth: (\d+)/.exec(info)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(info)?.[1]);
  if (!width || !height) throw Error("Cannot read the image size");
  const scale = Math.min(columns / width, (rows * 2) / height, 1);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const directory = await mkdtemp(join(tmpdir(), "hikaro-preview-"));
  try {
    const out = join(directory, "preview.bmp");
    await run("/usr/bin/sips", [
      "-s",
      "format",
      "bmp",
      "-z",
      String(h),
      String(w),
      path,
      "--out",
      out,
    ]);
    return { lines: halfBlocks(decodeBmp(await readFile(out))), width, height };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A closable in-terminal image viewer for a composer image chip. */
export class ImagePreview implements Component {
  private lines: string[] = [];
  private status = "Loading…";
  private size?: {
    width: number;
    height: number;
    columns: number;
    rows: number;
  };

  constructor(
    private readonly label: string,
    private readonly path: string,
    private readonly screen: () => { columns: number; rows: number },
    private readonly requestRender: () => void,
    private readonly close: () => void,
    private readonly openExternal: () => void,
    private readonly draw = renderImage,
  ) {}

  invalidate() {}

  render(width: number) {
    const { rows } = this.screen();
    const columns = Math.max(1, width - 2);
    // The overlay takes at most 90% of the rows; five go to title, spacing and keys.
    const imageRows = Math.max(1, Math.floor(rows * 0.9) - 5);
    if (
      !this.size ||
      this.size.columns !== columns ||
      this.size.rows !== imageRows
    )
      this.load(columns, imageRows);
    const pad = (line: string) =>
      line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    const center = (line: string) =>
      pad(
        " ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2))) +
          line,
      );
    const title = `${this.label} · ${basename(this.path)}${this.size?.width ? ` · ${this.size.width}×${this.size.height}` : ""}`;
    return [
      pad(accent(truncateToWidth(` ${title}`, width, "…"))),
      pad(""),
      ...(this.lines.length
        ? this.lines.map(center)
        : [center(muted(this.status))]),
      pad(""),
      pad(muted(truncateToWidth(" Esc close · O open in Preview", width, ""))),
    ];
  }

  private load(columns: number, rows: number) {
    this.size = { width: 0, height: 0, columns, rows };
    const size = this.size;
    void this.draw(this.path, columns, rows).then(
      (image) => {
        if (this.size !== size) return;
        this.lines = image.lines;
        size.width = image.width;
        size.height = image.height;
        this.requestRender();
      },
      (error: unknown) => {
        if (this.size !== size) return;
        this.lines = [];
        this.status = error instanceof Error ? error.message : String(error);
        this.requestRender();
      },
    );
  }

  handleInput(data: string) {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    )
      this.close();
    else if (data === "o" || data === "O") this.openExternal();
  }
}
