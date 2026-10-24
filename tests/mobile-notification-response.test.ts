import { expect, it, vi } from "vitest";
import { observeNotificationResponses } from "../apps/mobile/src/notification-response.ts";

function fixture(phase = "connected", identity: string | null = "pairing-1") {
  const listeners = new Set<() => void>();
  let responseListener: (response: unknown) => void = () => {};
  const controller = {
    state: { phase },
    notificationIdentity: identity,
    matchesPushHost: (host: unknown) => host === "host-1",
    refreshNotificationTasks: vi.fn(async (_identity: string) => true),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const api = {
    DEFAULT_ACTION_IDENTIFIER: "default",
    getLastNotificationResponse: vi.fn((): unknown => null),
    clearLastNotificationResponse: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn(
      (listener: (response: unknown) => void) => {
        responseListener = listener;
        return { remove: vi.fn() };
      },
    ),
  };
  const open = vi.fn();
  return {
    controller,
    api,
    open,
    start: (load = async () => api) =>
      observeNotificationResponses(controller, load, open),
    receive: (response: unknown) => responseListener(response),
    change: (
      nextPhase: string,
      nextIdentity = controller.notificationIdentity,
    ) => {
      controller.state = { phase: nextPhase };
      controller.notificationIdentity = nextIdentity;
      for (const listener of listeners) listener();
    },
  };
}
const response = (
  id = "notification-1",
  hostId = "host-1",
  actionIdentifier = "default",
) => ({
  actionIdentifier,
  notification: {
    request: {
      identifier: id,
      content: {
        data: {
          hostId,
          url: "hikaro://approval?allow=true",
          sessionId: "untrusted-task",
        },
      },
    },
  },
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("waits for cold-start restoration, refreshes authority before navigation, and deduplicates last response", async () => {
  const f = fixture("restoring", null);
  f.api.getLastNotificationResponse.mockReturnValue(response());
  const stop = f.start();
  await settle();
  expect(f.controller.refreshNotificationTasks).not.toHaveBeenCalled();
  f.change("connecting", "pairing-1");
  expect(f.open).not.toHaveBeenCalled();
  f.change("connected");
  await settle();
  expect(f.controller.refreshNotificationTasks).toHaveBeenCalledExactlyOnceWith(
    "pairing-1",
  );
  expect(f.open).toHaveBeenCalledExactlyOnceWith();
  f.receive(response());
  stop();
  const stopAgain = f.start();
  await settle();
  expect(f.open).toHaveBeenCalledTimes(1);
  stopAgain();
});

it("defers a background tap until the same pairing reconnects", async () => {
  const f = fixture("background");
  const stop = f.start();
  await settle();
  f.receive(response());
  expect(f.controller.refreshNotificationTasks).not.toHaveBeenCalled();
  f.change("restoring");
  f.change("connected");
  await settle();
  expect(f.open).toHaveBeenCalledTimes(1);
  stop();
});

it.each(["different-host", "custom-action", "malformed", "unpaired"])(
  "ignores %s responses without querying or navigating",
  async (kind) => {
    const f = fixture(
      kind === "unpaired" ? "unpaired" : "connected",
      kind === "unpaired" ? null : "pairing-1",
    );
    const stop = f.start();
    await settle();
    f.receive(
      kind === "malformed"
        ? {}
        : response(
            "id",
            kind === "different-host" ? "other-host" : "host-1",
            kind === "custom-action" ? "approve" : "default",
          ),
    );
    await settle();
    expect(f.controller.refreshNotificationTasks).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    stop();
  },
);

it("drops deferred taps across forget and pairing changes, even when the host stays the same", async () => {
  const f = fixture("background");
  const stop = f.start();
  await settle();
  f.receive(response());
  f.change("blocked", null);
  f.change("connected", "pairing-2");
  await settle();
  expect(f.controller.refreshNotificationTasks).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
  stop();
});

it.each(["identity", "background", "dispose", "failure", "superseded"])(
  "does not navigate after an in-flight refresh becomes invalid (%s)",
  async (kind) => {
    const f = fixture();
    let complete!: (value: boolean) => void;
    f.controller.refreshNotificationTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const stop = f.start();
    await settle();
    f.receive(response());
    expect(f.open).not.toHaveBeenCalled();
    if (kind === "identity") f.change("connected", "pairing-2");
    if (kind === "background") f.change("background");
    if (kind === "dispose") stop();
    complete(kind !== "failure" && kind !== "superseded");
    await settle();
    expect(f.open).not.toHaveBeenCalled();
    stop();
  },
);

it("contains missing native support and cleans listeners on unmount", async () => {
  const f = fixture();
  const stopMissing = f.start(async () => {
    throw Error("Native module missing");
  });
  await settle();
  stopMissing();
  const stop = f.start();
  await settle();
  stop();
  expect(
    f.api.addNotificationResponseReceivedListener.mock.results[0]!.value.remove,
  ).toHaveBeenCalledTimes(1);
  f.receive(response());
  await settle();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not bind a cached response to a new pairing while the native module is loading", async () => {
  const f = fixture();
  f.api.getLastNotificationResponse.mockReturnValue(response());
  let load!: (api: typeof f.api) => void;
  const stop = f.start(
    () =>
      new Promise((resolve) => {
        load = resolve;
      }),
  );
  f.change("blocked", null);
  f.change("connected", "pairing-2");
  load(f.api);
  await settle();
  expect(f.controller.refreshNotificationTasks).not.toHaveBeenCalled();
  f.receive(response("new-notification"));
  await settle();
  expect(f.controller.refreshNotificationTasks).toHaveBeenCalledExactlyOnceWith(
    "pairing-2",
  );
  stop();
});

it("contains refresh rejection and does not leave an unhandled navigation promise", async () => {
  const f = fixture();
  f.controller.refreshNotificationTasks.mockRejectedValue(
    Error("Host unavailable"),
  );
  const stop = f.start();
  await settle();
  f.receive(response());
  await settle();
  expect(f.open).not.toHaveBeenCalled();
  stop();
});
