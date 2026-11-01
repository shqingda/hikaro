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
