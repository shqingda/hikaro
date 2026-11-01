import { expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  ImagePreview,
  decodeBmp,
  halfBlocks,
} from "../packages/tui/src/image-preview.ts";

/** A bottom-up 24-bit BMP, as `sips` writes it. */
function bmp(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
) {
  const stride = Math.floor((24 * width + 31) / 32) * 4;
  const data = Buffer.alloc(54 + stride * height);
  data.write("BM", 0, "latin1");
  data.writeUInt32LE(54, 10);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = 54 + (height - 1 - y) * stride + x * 3;
      data[at] = b!;
      data[at + 1] = g!;
      data[at + 2] = r!;
    }
  return data;
}

it("draws two pixel rows per terminal row from a bottom-up BMP", () => {
  const pixels = decodeBmp(
    bmp(3, 2, (_x, y) => (y === 0 ? [255, 0, 0] : [0, 0, 255])),
  );
  expect(pixels.rgb(1, 0)).toEqual([255, 0, 0]);
  expect(pixels.rgb(1, 1)).toEqual([0, 0, 255]);
  const lines = halfBlocks(pixels);
  expect(lines).toHaveLength(1);
  expect(stripVTControlCharacters(lines[0]!)).toBe("▀▀▀");
  expect(lines[0]).toContain("\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀");
});

it("previews in a box with the image facts, opens externally on O and closes on Esc", async () => {
  const close = vi.fn();
  const open = vi.fn();
  const render = vi.fn();
  const draw = vi.fn(() => ["▀▀"]);
  const preview = new ImagePreview(
    "Image #1",
    "/tmp/shot.png",
    () => 12,
    render,
    close,
    open,
    async () => ({
      format: "PNG",
      width: 1476,
      height: 894,
      bytes: 2.4 * 1024 * 1024,
      draw,
    }),
  );
  expect(stripVTControlCharacters(preview.render(60).join("\n"))).toContain(
    "Loading…",
  );
  await vi.waitFor(() => expect(render).toHaveBeenCalled());
  const lines = preview.render(60);
  const screen = stripVTControlCharacters(lines.join("\n"));
  expect(screen).toContain("Image #1 · PNG · 1476×894 · 2.4 MB · shot.png");
  expect(screen).toContain("Path: /tmp/shot.png");
  expect(screen).toContain("Esc close · O open in Preview");
  expect(screen).toContain("▀▀");
  expect(draw).toHaveBeenCalledWith(56, 8);
  for (const line of lines)
    expect(stripVTControlCharacters(line).length).toBe(60);
  preview.render(60);
  expect(draw).toHaveBeenCalledOnce();
  preview.handleInput("o");
  expect(open).toHaveBeenCalledOnce();
  preview.handleInput("\x1b");
  expect(close).toHaveBeenCalledOnce();
});
