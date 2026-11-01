import { expect, it } from "vitest";
import {
  detachImagePaths,
  presentUserText,
  textWithImageReferences,
} from "../packages/tui/src/image-chips.ts";

it("turns a pasted screenshot path into a path-free image chip", () => {
  const pasted =
    "/var/folders/xt/T/NSIRD_screencaptureui_QOgfNS/Screenshot\\ 2026-10-31\\ at\\ 00.02.44.png";
  const detached = detachImagePaths(pasted);
  expect(detached.text.trim()).toBe("");
  expect(detached.chips).toEqual([
    {
      label: "Image #1",
      path: "/var/folders/xt/T/NSIRD_screencaptureui_QOgfNS/Screenshot 2026-10-31 at 00.02.44.png",
    },
  ]);
  const stored = textWithImageReferences("图1太长了", detached.chips);
  const shown = presentUserText(stored);
  expect(shown.text).toContain("[Image #1]");
  expect(shown.text).toContain("图1太长了");
  expect(shown.text).not.toContain("NSIRD");
  expect(shown.chips[0]?.path).toContain("Screenshot 2026-10-31");
});
