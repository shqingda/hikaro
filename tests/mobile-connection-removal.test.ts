import { expect, it, vi } from "vitest";
import { connectionRemoval } from "../apps/mobile/src/connection-removal.ts";

function connection(identity: string | null = "pairing-1") {
  return {
    notificationIdentity: identity,
    state: {},
    forget: vi.fn(async () => {}),
  };
}

it("keeps pairing and drafts when removal is cancelled or dismissed", async () => {
  const controller = connection();
  const prompt = connectionRemoval(controller);
  expect(controller.forget).not.toHaveBeenCalled();
  prompt.cancel();
  expect(await prompt.confirm()).toBe("ignored");
  expect(controller.forget).not.toHaveBeenCalled();
});

it("removes only once even when confirmation repeats before storage finishes", async () => {
  const controller = connection();
  let finish!: () => void;
  controller.forget.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const prompt = connectionRemoval(controller);
  const first = prompt.confirm();
  expect(await prompt.confirm()).toBe("ignored");
  expect(controller.forget).toHaveBeenCalledTimes(1);
  finish();
  expect(await first).toBe("removed");
});

it("cannot remove a new pairing with an old confirmation after disconnecting", async () => {
  const controller = connection();
  const prompt = connectionRemoval(controller);
  controller.notificationIdentity = null;
  controller.state = {};
  controller.notificationIdentity = "pairing-2";
  expect(await prompt.confirm()).toBe("changed");
  expect(controller.forget).not.toHaveBeenCalled();
});

it("allows live state refreshes while the paired identity stays the same", async () => {
  const controller = connection();
  const prompt = connectionRemoval(controller);
  controller.state = {};
  expect(await prompt.confirm()).toBe("removed");
  expect(controller.forget).toHaveBeenCalledTimes(1);
});

it("binds damaged or restoring connections without identity to their original state", async () => {
  const unchanged = connection(null);
  expect(await connectionRemoval(unchanged).confirm()).toBe("removed");
  const changed = connection(null);
  const prompt = connectionRemoval(changed);
  changed.state = {};
  expect(await prompt.confirm()).toBe("changed");
  expect(changed.forget).not.toHaveBeenCalled();
});

it("does not retry a failed erase through the same confirmation", async () => {
  const controller = connection();
  controller.forget.mockRejectedValue(new Error("storage unavailable"));
  const prompt = connectionRemoval(controller);
  await expect(prompt.confirm()).rejects.toThrow("storage unavailable");
  expect(await prompt.confirm()).toBe("ignored");
  expect(controller.forget).toHaveBeenCalledTimes(1);
});
