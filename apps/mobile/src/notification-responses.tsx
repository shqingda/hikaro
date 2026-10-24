import { useEffect } from "react";
import { requireOptionalNativeModule } from "expo";
import { router } from "expo-router";
import { useMobile } from "./provider";
import { observeNotificationResponses } from "./notification-response";

export function NotificationResponses() {
  const { controller } = useMobile();
  useEffect(
    () =>
      observeNotificationResponses(
        controller,
        async () => {
          if (!requireOptionalNativeModule("ExpoNotificationsEmitter"))
            throw Error(
              "Notification responses unavailable in this installation",
            );
          return import("expo-notifications");
        },
        () => router.replace("/tasks"),
      ),
    [controller],
  );
  return null;
}
