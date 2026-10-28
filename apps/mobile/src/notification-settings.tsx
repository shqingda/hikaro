import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { useMobile } from "./provider";
import { Action, Note } from "./ui";

export function NotificationSettings() {
  const { controller, state } = useMobile();
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  const identity = controller.pushIdentity;
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setMessage("");
    return () => {
      generation.current++;
    };
  }, [identity]);
  async function configure(enable: boolean) {
    const operation = ++generation.current;
    setBusy(true);
    setMessage("");
    try {
      let token: string | null = null;
      if (enable) {
        if (typeof projectId !== "string" || !projectId)
          throw Error("当前安装包未配置推送项目，暂时无法启用通知。");
        if (!requireOptionalNativeModule("ExpoPushTokenManager"))
          throw Error("请更新安装包后启用通知。");
        const notifications = await import("expo-notifications");
        if (Platform.OS === "android")
          await notifications.setNotificationChannelAsync("default", {
            name: "任务通知",
            importance: notifications.AndroidImportance.DEFAULT,
          });
        let permission = await notifications.getPermissionsAsync();
        if (!permission.granted)
          permission = await notifications.requestPermissionsAsync();
        if (!permission.granted)
          throw Error("通知权限未开启，请在系统设置中允许通知。");
        token = (await notifications.getExpoPushTokenAsync({ projectId })).data;
      }
      if (generation.current !== operation) return;
      await controller.configurePush(token, identity);
      if (generation.current === operation)
        setMessage(
          enable ? "已为这台电脑注册通知。" : "已关闭这台电脑的通知。",
        );
    } catch {
      if (generation.current === operation)
        setMessage(
          "通知设置未完成。请确认安装包已配置推送项目、系统允许通知，并保持电脑连接后重试。",
        );
    } finally {
      if (generation.current === operation) setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <Note>
        {projectId
          ? "推送项目已配置，实际收件尚待验收。"
          : "推送项目暂未配置。"}
      </Note>
      <Action
        title="开启或更新任务通知"
        quiet
        disabled={state.phase !== "connected" || busy || !projectId}
        onPress={() => {
          void configure(true);
        }}
      />
      <Action
        title="关闭任务通知"
        quiet
        disabled={state.phase !== "connected" || busy}
        onPress={() => {
          void configure(false);
        }}
      />
      {!!message && <Note>{message}</Note>}
    </View>
  );
}
