import * as z from "zod";

interface NotificationController {
  readonly state: { phase: string };
  readonly notificationIdentity: string | null;
  matchesPushHost(hostId: unknown): boolean;
  refreshNotificationTasks(identity: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}
export interface NotificationResponseSource {
  DEFAULT_ACTION_IDENTIFIER: string;
  getLastNotificationResponse(): unknown;
  clearLastNotificationResponse(): void;
  addNotificationResponseReceivedListener(
    listener: (response: unknown) => void,
  ): { remove(): void };
}
const responseSchema = z.object({
  actionIdentifier: z.string(),
  notification: z.object({
    request: z.object({
      identifier: z.string().min(1).max(256),
      content: z.object({
        data: z.object({ hostId: z.string().min(1).max(128) }),
      }),
    }),
  }),
});
// A root-layout remount must not replay a native response if clearing it failed.
const seenByController = new WeakMap<NotificationController, Set<string>>();

/** A notification is only a hint to re-read the paired host's authorized list. */
export function observeNotificationResponses(
  controller: NotificationController,
  load: () => Promise<NotificationResponseSource>,
  openTasks: () => void,
) {
  let active = true;
  let revision = 0;
  let sourceReady = false;
  let startupIdentity = controller.notificationIdentity;
  let staleStartupResponse = false;
  let pending: { hostId: string; identity: string | null } | undefined;
  let subscription: { remove(): void } | undefined;
  const seen = seenByController.get(controller) ?? new Set<string>();
  seenByController.set(controller, seen);

  function advance() {
    if (!active) return;
    const phase = controller.state.phase;
    if (!sourceReady) {
      const identity = controller.notificationIdentity;
      if (startupIdentity && identity !== startupIdentity)
        staleStartupResponse = true;
      startupIdentity ??= identity;
      if (["unpaired", "review", "blocked", "revoked"].includes(phase))
        staleStartupResponse = true;
    }
    if (["unpaired", "review", "blocked", "revoked"].includes(phase)) {
      pending = undefined;
      revision++;
      return;
    }
    if (!pending) return;
    const identity = controller.notificationIdentity;
    if (pending.identity && identity !== pending.identity) {
      pending = undefined;
      return;
    }
    if (!identity) {
      if (phase === "error") pending = undefined;
      return;
    }
    if (!controller.matchesPushHost(pending.hostId)) {
      pending = undefined;
      return;
    }
    pending.identity = identity;
    if (phase !== "connected") return;
    pending = undefined;
    const operation = ++revision;
    void controller
      .refreshNotificationTasks(identity)
      .then((fresh) => {
        if (
          fresh &&
          active &&
          operation === revision &&
          controller.notificationIdentity === identity &&
          controller.state.phase === "connected"
        )
          openTasks();
      })
      .catch(() => {
        // The controller exposes read failures; a failed hint never triggers navigation.
      });
  }
  const unsubscribe = controller.subscribe(advance);

  void load()
    .then((source) => {
      if (!active) return;
      sourceReady = true;
      const receive = (raw: unknown) => {
        if (!active) return;
        // Consume the native last response even when malformed or for a removed pairing.
        try {
          source.clearLastNotificationResponse();
        } catch {
          /* Older native builds may not support clearing. */
        }
        const parsed = responseSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.actionIdentifier !== source.DEFAULT_ACTION_IDENTIFIER
        )
          return;
        const request = parsed.data.notification.request;
        if (seen.has(request.identifier)) return;
        seen.add(request.identifier);
        if (seen.size > 64) seen.delete(seen.values().next().value!);
        revision++;
        pending = {
          hostId: request.content.data.hostId,
          identity: controller.notificationIdentity,
        };
        advance();
      };
      // Subscribe first so an interaction cannot fall between reading and listening.
      // Expo 58 synchronous response APIs: https://docs.expo.dev/versions/latest/sdk/notifications/
      subscription = source.addNotificationResponseReceivedListener(receive);
      const last = source.getLastNotificationResponse();
      if (last) {
        if (staleStartupResponse) {
          try {
            source.clearLastNotificationResponse();
          } catch {
            /* Optional native cleanup. */
          }
        } else receive(last);
      }
    })
    .catch(() => {
      // Optional notifications must not prevent launch in an older installed binary.
      subscription?.remove();
      subscription = undefined;
    });
  return () => {
    active = false;
    revision++;
    pending = undefined;
    unsubscribe();
    subscription?.remove();
    subscription = undefined;
  };
}
