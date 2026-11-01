import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  allocateImageId,
  getCapabilities,
  getPngDimensions,
  matchesKey,
  renderImage,
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

/** An opened image: its facts plus a way to draw it into a cell box. */
export type Picture = {
  format: string;
  width: number;
  height: number;
  bytes: number;
  draw(columns: number, rows: number): Promise<string[]> | string[];
};

const sipsSize = async (path: string) => {
  const info = await run("/usr/bin/sips", [
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    "-g",
    "format",
    path,
  ]);
  return {
    width: Number(/pixelWidth: (\d+)/.exec(info)?.[1]),
    height: Number(/pixelHeight: (\d+)/.exec(info)?.[1]),
    format: /format: (\w+)/.exec(info)?.[1]?.toUpperCase() ?? "IMAGE",
  };
};

/** Convert with `sips` into a temporary file and read the result. */
async function convert(path: string, args: string[], extension: string) {
  const directory = await mkdtemp(join(tmpdir(), "hikaro-preview-"));
  try {
    const out = join(directory, `preview.${extension}`);
    await run("/usr/bin/sips", [...args, path, "--out", out]);
    return await readFile(out);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Open an image for preview. Kitty-protocol terminals (kitty, Ghostty, WezTerm,
 * Warp) get the real pixels, as in Grok Build; others get half blocks.
 */
export async function openPicture(path: string): Promise<Picture> {
  if (process.platform !== "darwin")
    throw Error("Inline preview needs macOS; press O to open the image.");
  const [{ width, height, format }, info] = await Promise.all([
    sipsSize(path),
    stat(path),
  ]);
  if (!width || !height) throw Error("Cannot read the image size");
  const base = { format, width, height, bytes: info.size };
  if (getCapabilities().images === "kitty") {
    // Kitty takes PNG only; sips keeps colour profiles while converting.
    const png = (
      format === "PNG"
        ? await readFile(path)
        : await convert(path, ["-s", "format", "png"], "png")
    ).toString("base64");
    const dimensions = getPngDimensions(png) ?? {
      widthPx: width,
      heightPx: height,
    };
    const imageId = allocateImageId();
    return {
      ...base,
      draw(columns, rows) {
        const image = renderImage(png, dimensions, {
          maxWidthCells: columns,
          maxHeightCells: rows,
          imageId,
          moveCursor: false,
        });
        if (!image) return [];
        const pad = " ".repeat(Math.floor((columns - image.columns) / 2));
        // The placement keeps the cursor still; spaces hold its cells.
        return [
          pad + image.sequence + " ".repeat(columns - pad.length),
          ...Array.from({ length: image.rows - 1 }, () => ""),
        ];
      },
    };
  }
  return {
    ...base,
    async draw(columns, rows) {
      const scale = Math.min(columns / width, (rows * 2) / height, 1);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const bmp = await convert(
        path,
        ["-s", "format", "bmp", "-z", String(h), String(w)],
        "bmp",
      );
      return halfBlocks(decodeBmp(bmp));
    },
  };
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A closable in-terminal image viewer for a composer image chip. */
export class ImagePreview implements Component {
  private picture?: Picture;
  private status = "Loading…";
  private lines: string[] = [];
  private box?: string;

  constructor(
    private readonly label: string,
    private readonly path: string,
    private readonly rows: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
    private readonly openExternal: () => void,
    open = openPicture,
    /** Where the user pasted it from, when `path` is Hikaro's copy. */
    private readonly shown = path,
  ) {
    void open(path).then(
      (picture) => {
        this.picture = picture;
        this.requestRender();
      },
      (error: unknown) => {
        this.status = error instanceof Error ? error.message : String(error);
        this.requestRender();
      },
    );
  }

  invalidate() {
    this.box = undefined;
  }

  render(width: number) {
    const inner = Math.max(1, width - 4);
    // Border, title, path line and bottom border.
    const imageRows = Math.max(1, this.rows() - 4);
    const picture = this.picture;
    const key = `${inner}x${imageRows}`;
    if (picture && this.box !== key) {
      this.box = key;
      const drawn = picture.draw(inner, imageRows);
      if (Array.isArray(drawn)) this.lines = drawn;
      else
        void drawn.then(
          (lines) => {
            if (this.box !== key) return;
            this.lines = lines;
            this.requestRender();
          },
          (error: unknown) => {
            this.status =
              error instanceof Error ? error.message : String(error);
            this.requestRender();
          },
        );
    }
    const border = muted;
    const row = (line: string) => {
      const fill = Math.max(0, inner - visibleWidth(line));
      return border("│ ") + line + " ".repeat(fill) + border(" │");
    };
    const center = (line: string) => {
      const left = Math.max(0, Math.floor((inner - visibleWidth(line)) / 2));
      return " ".repeat(left) + line;
    };
    const facts = picture
      ? ` · ${picture.format} · ${picture.width}×${picture.height} · ${size(picture.bytes)}`
      : "";
    const title = truncateToWidth(
      ` ${this.label}${facts} · ${basename(this.shown)} `,
      Math.max(1, width - 6),
      "…",
    );
    const titleWidth = visibleWidth(title);
    const left = Math.max(1, Math.floor((width - 2 - titleWidth) / 2));
    const keys = " Esc close · O open in Preview ";
    const bottomLeft = Math.max(1, width - 3 - visibleWidth(keys));
    const body = this.lines.length
      ? this.lines.map((line) =>
          line.includes("\x1b_G")
            ? border("│ ") + line + border(" │")
            : row(center(line)),
        )
      : [row(center(muted(this.status)))];
    return [
      border("╭" + "─".repeat(left)) +
        accent(title) +
        border("─".repeat(Math.max(0, width - 2 - left - titleWidth)) + "╮"),
      ...body,
      row(muted(truncateToWidth(`Path: ${this.shown}`, inner, "…"))),
      border("╰" + "─".repeat(bottomLeft)) + muted(keys) + border("─╯"),
    ];
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
