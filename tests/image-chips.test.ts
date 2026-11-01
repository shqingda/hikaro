import { expect, it } from "vitest";
import {
  imagesInText,
  inlineImagePaths,
  presentUserText,
  textWithImageReferences,
} from "../packages/tui/src/image-chips.ts";

it("turns a pasted screenshot path into an inline image token", () => {
  const pasted =
    "看 /var/folders/xt/T/NSIRD_screencaptureui_QOgfNS/Screenshot\\ 2026-10-31\\ at\\ 00.02.44.png 这个";
  const inline = inlineImagePaths(pasted);
  expect(inline.text).toBe("看 [Image #1] 这个");
  expect(inline.chips).toEqual([
    {
      label: "Image #1",
      path: "/var/folders/xt/T/NSIRD_screencaptureui_QOgfNS/Screenshot 2026-10-31 at 00.02.44.png",
    },
  ]);
  const stored = textWithImageReferences(inline.text, inline.chips);
  expect(stored).toContain("Screenshot 2026-10-31");
  const shown = presentUserText(stored);
  expect(shown.text).toBe("看 [Image #1] 这个");
  expect(shown.chips[0]?.path).toContain("Screenshot 2026-10-31");
});

it("numbers new images after known ones and drops deleted tokens on send", () => {
  const first = inlineImagePaths("/tmp/a.png ");
  const second = inlineImagePaths(first.text + "/tmp/b.png", first.chips);
  expect(second.text).toBe("[Image #1] [Image #2]");
  // Deleting #1 keeps it known for undo, but it is not sent.
  const edited = "[Image #2]x";
  expect(imagesInText(edited, second.chips).map((c) => c.label)).toEqual([
    "Image #2",
  ]);
  expect(textWithImageReferences(edited, second.chips)).toBe('@"/tmp/b.png" x');
  const again = inlineImagePaths(edited + " /tmp/c.png", second.chips);
  expect(again.text).toBe("[Image #2]x [Image #3]");
});

it("copies a pasted image so a vanished screenshot can still be sent", async () => {
  const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { stashImage } = await import("../packages/tui/src/image-stash.ts");
  const root = mkdtempSync(join(tmpdir(), "hikaro-stash-"));
  try {
    const source = join(root, "NSIRD_screencaptureui_x", "截屏 1.png");
    const store = join(root, "store");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    (await import("node:fs")).mkdirSync(join(root, "NSIRD_screencaptureui_x"));
    writeFileSync(source, png);
    const inline = inlineImagePaths(
      `看 ${source.replaceAll(" ", "\\ ")}`,
      [],
      (path) => stashImage(path, store),
    );
    const chip = inline.chips[0]!;
    expect(inline.text).toBe("看 [Image #1]");
    expect(chip.source).toBe(source);
    expect(chip.path.startsWith(store)).toBe(true);
    rmSync(join(root, "NSIRD_screencaptureui_x"), { recursive: true });
    expect(readFileSync(chip.path)).toEqual(png);
    expect(textWithImageReferences(inline.text, inline.chips)).toContain(
      chip.path,
    );
    // Pasting the same source again reuses the chip.
    expect(
      inlineImagePaths(
        `${inline.text} ${source.replaceAll(" ", "\\ ")}`,
        inline.chips,
      ).text,
    ).toBe("看 [Image #1] [Image #1]");
    const text = join(root, "notes.png");
    writeFileSync(text, "not an image");
    expect(stashImage(text, store)).toBe(text);
    const secret = join(root, ".ssh", "key.png");
    (await import("node:fs")).mkdirSync(join(root, ".ssh"));
    writeFileSync(secret, png);
    expect(stashImage(secret, store)).toBe(secret);
    expect(existsSync(store)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
