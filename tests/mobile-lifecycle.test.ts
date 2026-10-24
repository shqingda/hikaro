import { expect, it, vi } from "vitest";
import { mobileLifecycle } from "../apps/mobile/src/lifecycle.ts";

it("keeps the connection across permission sheets but suspends and restores actual background transitions", () => {
  const controller = { restore: vi.fn(async () => {}), suspend: vi.fn() };
  const change = mobileLifecycle(controller, "active");
  change("inactive");
  change("active");
  expect(controller.restore).toHaveBeenCalledTimes(1);
  expect(controller.suspend).not.toHaveBeenCalled();
  change("inactive");
  change("background");
  change("background");
  expect(controller.suspend).toHaveBeenCalledTimes(1);
  change("active");
  change("active");
  expect(controller.restore).toHaveBeenCalledTimes(2);
});

it("waits for active when launched in an unknown or inactive state", () => {
  for (const initial of [undefined, null, "inactive", "background"]) {
    const controller = { restore: vi.fn(async () => {}), suspend: vi.fn() };
    const change = mobileLifecycle(controller, initial);
    expect(controller.restore).not.toHaveBeenCalled();
    change("active");
    expect(controller.restore).toHaveBeenCalledTimes(1);
  }
});
